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
MAX_UPLOAD_MB=100
ADMIN_API_KEY=user-adminAPIKeyChangeMe0000000000000
```

- `URI_PREFIX` is the mounted app path.
- `ACCESS_URL` is the public URL used when generating download links and CLI upload commands.
- `ADMIN_API_KEY` is an extra login-only key for the built-in `admin` account. The admin account's normal login/upload/download keys are generated randomly.
- `MAX_UPLOAD_MB` controls ZIP upload size.

## Databases

GetAgents supports:

- SQLite by default, when `SQL_DSN` is empty.
- MySQL when `SQL_DSN` is set.

SQLite data is stored at:

```text
~/.getagents/getagents.sqlite
```

MySQL DSN example:

```env
SQL_DSN=mysql://user:password@127.0.0.1:3306/getagents
```

The database stores metadata only: users, managed tags, agents, versions, share tokens, and import records. ZIP package contents are stored by the file storage backend.

## File Storage

`STORAGE_DRIVER` currently supports three values:

- `local`: store ZIP packages on the local filesystem.
- `agfs`: store ZIP packages through an AGFS server using AGFS file paths.
- `s3`: store ZIP packages directly in an S3-compatible object store.

Default local storage:

```env
STORAGE_DRIVER=local
```

Local ZIP files are stored at:

```text
~/.getagents/agents/uploads/<agentId>/v1.zip
~/.getagents/agents/uploads/<agentId>/v2.zip
~/.getagents/agents/downloads/<agentId>/current.zip
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

Stored package paths:

```text
/s3fs/getagents/uploads/<agentId>/v1.zip
/s3fs/getagents/uploads/<agentId>/v2.zip
/s3fs/getagents/downloads/<agentId>/current.zip
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
```

Stored object keys:

```text
agents/uploads/<agentId>/v1.zip
agents/uploads/<agentId>/v2.zip
agents/downloads/<agentId>/current.zip
```

`AWS_BUCKET_URI` combines the bucket and key prefix. For example, `s3://getagents/agents` stores packages under the `agents/` prefix in the `getagents` bucket.

For AWS S3, `AWS_ENDPOINT_URL` can be left empty. For S3-compatible services such as MinIO, set `AWS_ENDPOINT_URL`.

## CLI Upload

The Agents page generates upload/update commands after the required agent information is filled in.

Example:

```bash
GETAGENTS_API_KEY=user-xxx bash <(curl -fsSL http://localhost:3000/getagents/cli/upload.sh) \
  --type workspace \
  --name 'My Agent' \
  --description 'What this agent does'
```

Agent types are managed from the Admin page. Each type can define one or more backup directories, and the generated command includes one `--source` argument per configured directory. You can still override the command manually with your own `--source` values.

Default type presets are created for each user:

```text
workspace    ${PWD}
cursor       ${HOME}/.cursor
claude       ${HOME}/.claude
codex        ${HOME}/.codex
gemini       ${HOME}/.gemini
openclaw     ${HOME}/.openclaw
hermes-agent ${HOME}/.hermes
```

The generated command includes `--type`, so creating or updating an agent preserves the type metadata and backs up the matching runtime directories by default.

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
