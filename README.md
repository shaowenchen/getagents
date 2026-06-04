# GetAgents

GetAgents is an AgentHome ZIP package manager. It stores agent metadata in a database and stores uploaded ZIP packages in a pluggable file backend.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

```text
http://localhost:3000/getagents
```

Build and run production output:

```bash
npm run build
npm start
```

## Configuration

Core environment variables:

```env
PORT=3000
HOST=0.0.0.0
URI_PREFIX=/getagents
ACCESS_URL=http://localhost:3000/getagents
SESSION_SECRET=getagents-session-secret-change-me
LOG_LEVEL=debug
SQL_DSN=
MAX_UPLOAD_MB=500
ADMIN_API_KEY=user-adminAPIKeyChangeMe0000000000000
```

- `URI_PREFIX` is the mounted app path.
- `ACCESS_URL` is the public URL used when generating download links and CLI upload commands.
- `ADMIN_API_KEY` is an extra login-only key for the built-in `admin` account. The admin account's normal login/upload/download keys are generated randomly.
- `MAX_UPLOAD_MB` controls ZIP upload size.

## Users And Keys

Each user has three independent keys with different permissions:

- Login API Key: signs in to the web UI and can call authenticated management APIs.
- Upload API Key: used by the CLI upload script only.
- Download API Key: used for private package downloads only.

The keys are intentionally not interchangeable. For example, a login key cannot upload or download packages as an API key, and a download key cannot sign in.

Usernames must be 8-30 characters and contain only lowercase letters and numbers. Agent names must be unique per user, 8-30 characters, and contain only lowercase letters, numbers, and hyphens.

## Databases

GetAgents supports:

- SQLite by default, when `SQL_DSN` is empty or starts with `sqlite:`.
- MySQL when `SQL_DSN` starts with `mysql://`.

SQLite data is stored at:

```text
~/.getagents/getagents.sqlite
```

SQLite DSN examples:

```env
# Default path (~/.getagents/getagents.sqlite)
SQL_DSN=

# Absolute path
SQL_DSN=sqlite:////data/getagents.sqlite

# Relative path (relative to working directory)
SQL_DSN=sqlite:./data/getagents.sqlite
```

MySQL DSN example:

```env
SQL_DSN=mysql://user:password@127.0.0.1:3306/getagents
```

The database stores metadata only: users, global managed tags, global managed agent types, agents, versions, share tokens, and import records. ZIP package contents are stored by the file storage backend.

Agent file metadata is stored in the database on both the current agent row and each version snapshot:

- `filePath`: backend-relative package path, such as `/<agentId>/file-v2.zip`
- `filename`: original uploaded filename for metadata only
- `fileSize`
- `fileHash`

## File Storage

`STORAGE_DRIVER` currently supports three values:

- `local`: store ZIP packages on the local filesystem.
- `agfs`: store ZIP packages through an AGFS server using AGFS file paths.
- `s3`: store ZIP packages directly in an S3-compatible object store.

Default local storage:

```env
STORAGE_DRIVER=local
```

Local ZIP files are stored under `~/.getagents/agents` using the database `filePath` value:

```text
~/.getagents/agents/<agentId>/file-v1.zip
~/.getagents/agents/<agentId>/file-v2.zip
```

GetAgents no longer writes a separate `current.zip`. The current downloadable file is resolved from the latest agent/version metadata in the database.

Existing deployments with older paths are still read-compatible during downloads and installs:

```text
uploads/<agentId>/vN.zip
downloads/<agentId>/current.zip
<agentId>/vN.zip
```

### AGFS Storage

GetAgents can store ZIP packages through [AGFS](https://github.com/c4pt0r/agfs), which exposes backends such as S3 as file paths over a REST API.

AGFS server health check:

```bash
curl http://localhost:8080/api/v1/health
```

Configure GetAgents to use AGFS:

```env
STORAGE_DRIVER=agfs
AGFS_API_URL=http://localhost:8080
AGFS_ROOT_PATH=/s3fs/getagents
```

Stored package paths use the database `filePath` value under `AGFS_ROOT_PATH`:

```text
/s3fs/getagents/<agentId>/file-v1.zip
/s3fs/getagents/<agentId>/file-v2.zip
```

To store packages in S3 through AGFS, configure S3 in AGFS and point `AGFS_ROOT_PATH` at the mounted S3 path, for example `/s3fs/getagents`.

### S3 Storage

Configure GetAgents to write ZIP packages directly to S3:

```env
STORAGE_DRIVER=s3
AWS_ENDPOINT_URL=
AWS_DEFAULT_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_BUCKET_URI=s3://getagents/agents
AWS_S3_FORCE_PATH_STYLE=
AWS_S3_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED
S3_DIRECT_UPLOAD_EXPIRES_SECONDS=900
```

Stored object keys use the database `filePath` value under the configured key prefix:

```text
agents/<agentId>/file-v1.zip
agents/<agentId>/file-v2.zip
```

`AWS_BUCKET_URI` combines the bucket and key prefix. For example, `s3://getagents/agents` stores packages under the `agents/` prefix in the `getagents` bucket.

For AWS S3, `AWS_ENDPOINT_URL` can be left empty. For S3-compatible services such as MinIO or KS3, set `AWS_ENDPOINT_URL`; host-only values are normalized to `https://...`.

`AWS_S3_FORCE_PATH_STYLE` can be set to `false` for providers that require virtual-host style bucket addressing. KS3 endpoints default to virtual-host style automatically. `AWS_S3_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` avoids SDK checksum headers that some S3-compatible providers reject.

When `STORAGE_DRIVER=s3`, the CLI first tries direct-to-object-storage upload through a presigned URL. Temporary direct-upload objects are stored under:

```text
agents/direct/<userId>/<uploadId>/agent.zip
```

After completion, the temporary object is copied to the final `agents/<agentId>/file-v<version>.zip` key and then deleted. If direct upload is unavailable or fails due to object-storage compatibility, the CLI falls back to the GetAgents relay upload endpoint.

## CLI Upload

The Agents page generates upload/update commands after the required agent information is filled in.

Example:

```bash
GETAGENTS_API_KEY=user-xxx bash <(curl -fsSL http://localhost:3000/getagents/cli/upload.sh) \
  --type currentdir \
  --name my-agent1 \
  --description 'What this agent does'
```

`GETAGENTS_API_KEY` must be the Upload API Key.

Agent types are managed globally from the Admin page. Each type can define one or more backup directories, and the generated command includes one `--source` argument per configured directory. You can still override the command manually with your own `--source` values.

Default global type presets:

```text
currentdir   ${PWD}
cursor       ${HOME}/.cursor
claude       ${HOME}/.claude
codex        ${HOME}/.codex
gemini       ${HOME}/.gemini
openclaw     ${OPENCLAW_HOME:-${HOME}/.openclaw}
hermes-agent ${HERMES_HOME:-${HOME}/.hermes}
```

The generated command includes `--type`, so creating or updating an agent preserves the type metadata and backs up the matching runtime directories by default.

The CLI packages regular files from the selected source directories. It does not exclude common development directories such as `.git`, `node_modules`, `dist`, or log files, but it skips non-regular files such as sockets, device files, and FIFOs.

## Downloads

Private downloads require the Download API Key, either via `X-API-Key`, `Authorization: ApiKey <key>`, or the `downloadKey` query parameter used by the web UI. Published marketplace versions can be downloaded publicly without a key.

Downloaded ZIP filenames are generated from the agent name and version, for example:

```text
my-agent1-v2.zip
```

## Kubernetes Deployment

Deployment manifests live in `deploy/`:

```text
deploy/deployment.yaml
deploy/service.yaml
```

Apply them with:

```bash
kubectl apply -f deploy/
```

Before deploying, update:

- `ACCESS_URL`
- `SESSION_SECRET`
- `ADMIN_API_KEY`, if you want an extra login-only key for the built-in `admin` account
- `SQL_DSN`, if using MySQL
- `STORAGE_DRIVER`
- `AGFS_API_URL` and `AGFS_ROOT_PATH`, if using AGFS storage
- `S3_*` and `AWS_*`, if using direct S3 storage
