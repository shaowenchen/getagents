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
    (cd "\${EXPANDED_SOURCE_DIRS[0]}" && zip -qr "\$ZIP_PATH" .)
  else
    for source in "\${EXPANDED_SOURCE_DIRS[@]}"; do
      parent="\$(dirname "\$source")"
      base="\$(basename "\$source")"
      (cd "\$parent" && zip -qr "\$ZIP_PATH" "\$base")
    done
  fi
elif command -v python3 >/dev/null 2>&1; then
  python3 - "\$ZIP_PATH" "\${EXPANDED_SOURCE_DIRS[@]}" <<'PYEOF'
import os, stat, sys, zipfile

dst, sources = sys.argv[1], sys.argv[2:]
def regular_dir(path):
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False

with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zf:
    for src in sources:
        root_prefix = os.path.basename(os.path.abspath(src)) if len(sources) > 1 else ''
        for root, dirs, files in os.walk(src):
            dirs[:] = [
                d for d in dirs
                if regular_dir(os.path.join(root, d))
            ]
            for f in files:
                full = os.path.join(root, f)
                try:
                    mode = os.lstat(full).st_mode
                except OSError:
                    continue
                if not stat.S_ISREG(mode):
                    continue
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
if command -v sha256sum >/dev/null 2>&1; then
  FILE_HASH="\$(sha256sum "\$ZIP_PATH" | awk '{print \$1}')"
elif command -v shasum >/dev/null 2>&1; then
  FILE_HASH="\$(shasum -a 256 "\$ZIP_PATH" | awk '{print \$1}')"
else
  FILE_HASH=""
fi
info "Archive: \$ZIP_PATH (\${SIZE_BYTES} bytes)"

json_payload() {
  python3 - "\$@" <<'PYEOF'
import json, sys
keys = [
    'agentId', 'name', 'type', 'description', 'tags', 'comment',
    'filename', 'fileSize', 'fileHash', 'directKey'
]
payload = {}
for key, value in zip(keys, sys.argv[1:]):
    if value != '':
        if key == 'fileSize':
            payload[key] = int(value)
        else:
            payload[key] = value
print(json.dumps(payload, separators=(',', ':')))
PYEOF
}

json_field() {
  python3 - "\$1" "\$2" <<'PYEOF'
import json, sys
try:
    data = json.loads(sys.argv[1])
    value = data
    for part in sys.argv[2].split('.'):
        value = value.get(part, '') if isinstance(value, dict) else ''
    if isinstance(value, (dict, list)):
        print(json.dumps(value, separators=(',', ':')))
    elif value is None:
        print('')
    else:
        print(value)
except Exception:
    print('')
PYEOF
}

try_direct_upload() {
  command -v python3 >/dev/null 2>&1 || return 1
  [[ -n "\$FILE_HASH" ]] || return 1

  local init_url="\${ENDPOINT%/}/api/cli/upload/direct/init"
  local complete_url="\${ENDPOINT%/}/api/cli/upload/direct/complete"
  local filename="\$(basename "\$ZIP_PATH")"
  local payload response direct upload_url direct_key complete_payload

  payload="\$(json_payload "\$AGENT_ID" "\$AGENT_NAME" "\$AGENT_TYPE" "\$DESCRIPTION" "\$TAGS" "\$COMMENT" "\$filename" "\$SIZE_BYTES" "\$FILE_HASH" "")"
  response="\$(curl -fsSL -X POST -H "X-API-Key: \$API_KEY" -H "Content-Type: application/json" --data "\$payload" "\$init_url" 2>/dev/null)" || return 1
  direct="\$(json_field "\$response" direct)"
  [[ "\$direct" == "True" || "\$direct" == "true" ]] || return 1
  upload_url="\$(json_field "\$response" url)"
  direct_key="\$(json_field "\$response" key)"
  [[ -n "\$upload_url" && -n "\$direct_key" ]] || return 1

  info "Direct uploading to object storage ..."
  if ! curl -fsSL -X PUT --upload-file "\$ZIP_PATH" "\$upload_url" >/dev/null 2>&1; then
    err "Direct object storage upload failed (check presigned URL / storage permissions)"
    return 1
  fi

  info "Finalizing direct upload ..."
  complete_payload="\$(json_payload "\$AGENT_ID" "\$AGENT_NAME" "\$AGENT_TYPE" "\$DESCRIPTION" "\$TAGS" "\$COMMENT" "\$filename" "\$SIZE_BYTES" "\$FILE_HASH" "\$direct_key")"
  if ! RESPONSE="\$(curl -fsSL -X POST -H "X-API-Key: \$API_KEY" -H "Content-Type: application/json" --data "\$complete_payload" "\$complete_url" 2>&1)"; then
    err "Direct upload finalize failed: \$RESPONSE"
    return 1
  fi
  echo "\$RESPONSE"
  info "Done."
  return 0
}

if try_direct_upload; then
  exit 0
fi
info "Direct upload unavailable or failed; falling back to GetAgents relay upload ..."

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
