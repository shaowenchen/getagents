// Bash script template served from GET <prefix>/cli/upload.sh.
// __ENDPOINT__ is replaced at request time with the running server's base URL
// (e.g. https://example.com/getagents). Users can still override with the
// GETAGENTS_ENDPOINT or ACCESS_URL env var.

export const UPLOAD_SCRIPT_TEMPLATE = `#!/usr/bin/env bash
# getagents-upload — Compress the current working directory and upload it
# to a GetAgents server as an agent package.
#
# Quick start (inside the agent's runtime environment):
#   curl -fsSL __ENDPOINT__/cli/upload.sh | \\
#     GETAGENTS_API_KEY=user-XXX bash -s -- --name "My Agent"
#
# Or download once and reuse:
#   curl -fsSL __ENDPOINT__/cli/upload.sh -o upload.sh
#   GETAGENTS_API_KEY=user-XXX bash upload.sh --agent-id <id>
#
# Environment variables (all overridable by flags):
#   GETAGENTS_ENDPOINT   Server base URL (overrides ACCESS_URL)
#   ACCESS_URL           Public GetAgents app URL used as the default endpoint
#   GETAGENTS_API_KEY    API key from the GetAgents admin page (required)
#   GETAGENTS_TYPE       Agent type metadata
#   GETAGENTS_SOURCE     Directory to upload (repeat --source for multiple dirs)

set -euo pipefail

ENDPOINT="\${GETAGENTS_ENDPOINT:-\${ACCESS_URL:-__ENDPOINT__}}"
API_KEY="\${GETAGENTS_API_KEY:-}"
AGENT_TYPE="\${GETAGENTS_TYPE:-currentdir}"
SOURCE_DIRS=()
[[ -n "\${GETAGENTS_SOURCE:-}" ]] && SOURCE_DIRS+=("\$GETAGENTS_SOURCE")
AGENT_ID=""
AGENT_NAME=""
DESCRIPTION=""
TAGS=""
COMMENT=""

usage() {
  cat <<EOF
Usage: bash upload.sh [options]

  -e, --endpoint URL       Server base URL (env GETAGENTS_ENDPOINT)
  -k, --api-key KEY        API key (env GETAGENTS_API_KEY)
      --type TYPE          Agent type metadata
  -s, --source DIR         Directory to upload (can be repeated)
  -i, --agent-id ID        Update an existing agent by ID
  -n, --name NAME          Agent name (used for create-or-update by name)
  -d, --description TEXT   Description (only applied on create / when provided)
  -t, --tags "a,b,c"       Comma-separated tags
      --comment TEXT       Version comment (shown in version history)
  -h, --help               Show this help

Examples:
  # Create or update by name
  bash upload.sh --name "Coding Helper"

  # Always update a specific agent
  bash upload.sh --agent-id 1a2b3c-...

  # Upload a different directory
  bash upload.sh --name "Helper" --source ./my-agent

When multiple --source values are provided, each directory is stored under its
basename inside the ZIP. Shell-style \$HOME, \${HOME}, \$PWD, \${PWD}, and ~
prefixes are expanded by the script.

EOF
}

while [[ \$# -gt 0 ]]; do
  case "\$1" in
    -e|--endpoint)     ENDPOINT="\${2:-}"; shift 2 ;;
    -k|--api-key)      API_KEY="\${2:-}"; shift 2 ;;
    --type)            AGENT_TYPE="\${2:-}"; shift 2 ;;
    -s|--source)       SOURCE_DIRS+=("\${2:-}"); shift 2 ;;
    -i|--agent-id)     AGENT_ID="\${2:-}"; shift 2 ;;
    -n|--name)         AGENT_NAME="\${2:-}"; shift 2 ;;
    -d|--description)  DESCRIPTION="\${2:-}"; shift 2 ;;
    -t|--tags)         TAGS="\${2:-}"; shift 2 ;;
    --comment)         COMMENT="\${2:-}"; shift 2 ;;
    -h|--help)         usage; exit 0 ;;
    *)                 echo "Unknown option: \$1" >&2; usage >&2; exit 2 ;;
  esac
done

err() { echo "[getagents] \$*" >&2; }
info() { echo "[getagents] \$*"; }

expand_source_path() {
  local path="\$1"
  if [[ "\$path" == "~" ]]; then
    printf '%s\\n' "\$HOME"
  elif [[ "\$path" == "\\\${HERMES_HOME:-\\\${HOME}/.hermes}" ]]; then
    printf '%s\\n' "\${HERMES_HOME:-\$HOME/.hermes}"
  elif [[ "\$path" == "\\\${OPENCLAW_HOME:-\\\${HOME}/.openclaw}" ]]; then
    printf '%s\\n' "\${OPENCLAW_HOME:-\$HOME/.openclaw}"
  elif [[ "\$path" == "~/"* ]]; then
    printf '%s/%s\\n' "\$HOME" "\${path:2}"
  elif [[ "\$path" == "\\\$HOME" ]]; then
    printf '%s\\n' "\$HOME"
  elif [[ "\$path" == "\\\$HOME/"* ]]; then
    printf '%s/%s\\n' "\$HOME" "\${path:6}"
  elif [[ "\$path" == "\\\${HOME}" ]]; then
    printf '%s\\n' "\$HOME"
  elif [[ "\$path" == "\\\${HOME}/"* ]]; then
    printf '%s/%s\\n' "\$HOME" "\${path:8}"
  elif [[ "\$path" == "\\\$PWD" ]]; then
    printf '%s\\n' "\$PWD"
  elif [[ "\$path" == "\\\$PWD/"* ]]; then
    printf '%s/%s\\n' "\$PWD" "\${path:5}"
  elif [[ "\$path" == "\\\${PWD}" ]]; then
    printf '%s\\n' "\$PWD"
  elif [[ "\$path" == "\\\${PWD}/"* ]]; then
    printf '%s/%s\\n' "\$PWD" "\${path:7}"
  else
    printf '%s\\n' "\$path"
  fi
}

[[ -z "\$ENDPOINT" ]] && { err "ENDPOINT is empty (set GETAGENTS_ENDPOINT or pass --endpoint)"; exit 2; }
[[ -z "\$API_KEY" ]] && { err "API key is required (set GETAGENTS_API_KEY or pass --api-key)"; exit 2; }

PING_URL="\${ENDPOINT%/}/api/cli/ping"
if ! curl -fsSL -H "X-API-Key: \$API_KEY" "\$PING_URL" >/dev/null; then
  err "Upload key is invalid for \$PING_URL. Copy the latest Upload API Key from Profile and retry."
  exit 22
fi

if [[ \${#SOURCE_DIRS[@]} -eq 0 ]]; then
  SOURCE_DIRS=("\$PWD")
fi

EXPANDED_SOURCE_DIRS=()
for source in "\${SOURCE_DIRS[@]}"; do
  expanded="\$(expand_source_path "\$source")"
  [[ ! -d "\$expanded" ]] && { err "Source directory not found: \$expanded"; exit 2; }
  EXPANDED_SOURCE_DIRS+=("\$expanded")
done

if [[ -z "\$AGENT_ID" && -z "\$AGENT_NAME" ]]; then
  AGENT_NAME="\$(basename "\$(cd "\${EXPANDED_SOURCE_DIRS[0]}" && pwd)")"
  info "No --agent-id / --name provided, defaulting name to: \$AGENT_NAME"
fi

command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 127; }

TMP_DIR="\$(mktemp -d 2>/dev/null || mktemp -d -t 'getagents')"
ZIP_PATH="\$TMP_DIR/agent.zip"
cleanup() { rm -rf "\$TMP_DIR"; }
trap cleanup EXIT INT TERM

source_label="source directories"
[[ \${#EXPANDED_SOURCE_DIRS[@]} -eq 1 ]] && source_label="source directory"
info "Packaging \${#EXPANDED_SOURCE_DIRS[@]} \$source_label for type '\$AGENT_TYPE' ..."

if command -v zip >/dev/null 2>&1; then
  if [[ \${#EXPANDED_SOURCE_DIRS[@]} -eq 1 ]]; then
    (cd "\${EXPANDED_SOURCE_DIRS[0]}" && zip -qr "\$ZIP_PATH" . \\
      -x '*/.git/*' '.git/*' \\
      -x '*/node_modules/*' 'node_modules/*' \\
      -x '*/__pycache__/*' '__pycache__/*' \\
      -x '*/.venv/*' '.venv/*' '*/venv/*' 'venv/*' \\
      -x '*/dist/*' 'dist/*' \\
      -x '*/build/*' 'build/*' \\
      -x '*/.cache/*' '.cache/*' \\
      -x '.DS_Store' '*/.DS_Store' \\
      -x '*.log')
  else
    for source in "\${EXPANDED_SOURCE_DIRS[@]}"; do
      parent="\$(dirname "\$source")"
      base="\$(basename "\$source")"
      (cd "\$parent" && zip -qr "\$ZIP_PATH" "\$base" \\
        -x '*/.git/*' '.git/*' \\
        -x '*/node_modules/*' 'node_modules/*' \\
        -x '*/__pycache__/*' '__pycache__/*' \\
        -x '*/.venv/*' '.venv/*' '*/venv/*' 'venv/*' \\
        -x '*/dist/*' 'dist/*' \\
        -x '*/build/*' 'build/*' \\
        -x '*/.cache/*' '.cache/*' \\
        -x '.DS_Store' '*/.DS_Store' \\
        -x '*.log')
    done
  fi
elif command -v python3 >/dev/null 2>&1; then
  python3 - "\$ZIP_PATH" "\${EXPANDED_SOURCE_DIRS[@]}" <<'PYEOF'
import os, sys, zipfile

dst, sources = sys.argv[1], sys.argv[2:]
skip = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.cache'}
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zf:
    for src in sources:
        root_prefix = os.path.basename(os.path.abspath(src)) if len(sources) > 1 else ''
        for root, dirs, files in os.walk(src):
            dirs[:] = [d for d in dirs if d not in skip]
            for f in files:
                if f == '.DS_Store' or f.endswith('.log'):
                    continue
                full = os.path.join(root, f)
                rel = os.path.relpath(full, src)
                arcname = os.path.join(root_prefix, rel) if root_prefix else rel
                zf.write(full, arcname)
PYEOF
else
  err "Neither 'zip' nor 'python3' is available — install one and retry"
  exit 127
fi

if [[ ! -s "\$ZIP_PATH" ]]; then
  err "Produced empty archive"
  exit 1
fi

SIZE_BYTES=\$(wc -c < "\$ZIP_PATH" | tr -d ' ')
info "Archive: \$ZIP_PATH (\${SIZE_BYTES} bytes)"

# Build curl form arguments
CURL_ARGS=(-fsSL -X POST
  -H "X-API-Key: \$API_KEY"
  -F "agentFile=@\$ZIP_PATH;type=application/zip")

[[ -n "\$AGENT_ID" ]]     && CURL_ARGS+=(-F "agentId=\$AGENT_ID")
[[ -n "\$AGENT_NAME" ]]   && CURL_ARGS+=(-F "name=\$AGENT_NAME")
[[ -n "\$AGENT_TYPE" ]]   && CURL_ARGS+=(-F "type=\$AGENT_TYPE")
[[ -n "\$DESCRIPTION" ]]  && CURL_ARGS+=(-F "description=\$DESCRIPTION")
[[ -n "\$TAGS" ]]         && CURL_ARGS+=(-F "tags=\$TAGS")
[[ -n "\$COMMENT" ]]      && CURL_ARGS+=(-F "comment=\$COMMENT")

UPLOAD_URL="\${ENDPOINT%/}/api/cli/upload"
info "Uploading to \$UPLOAD_URL ..."

if RESPONSE=\$(curl "\${CURL_ARGS[@]}" "\$UPLOAD_URL"); then
  echo "\$RESPONSE"
  info "Done."
else
  CODE=\$?
  err "Upload failed (curl exit \$CODE)"
  exit \$CODE
fi
`;

export function renderUploadScript(endpoint: string): string {
  return UPLOAD_SCRIPT_TEMPLATE.replaceAll('__ENDPOINT__', endpoint);
}
