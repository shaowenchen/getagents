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
ADMIN_API_KEY=user-admin-api-key-change-me
```

- `URI_PREFIX` is the mounted app path.
- `ACCESS_URL` is the public URL used when generating download links and CLI upload commands.
- `ADMIN_API_KEY` creates or unlocks the built-in `admin` user.
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

Default local storage:

```env
STORAGE_DRIVER=local
```

Local ZIP files are stored at:

```text
~/.getagents/agents/<agentId>/current.zip
~/.getagents/agents/<agentId>/v1.zip
~/.getagents/agents/<agentId>/v2.zip
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
/s3fs/getagents/agents/<agentId>/current.zip
/s3fs/getagents/agents/<agentId>/v1.zip
/s3fs/getagents/agents/<agentId>/v2.zip
```

To store packages in S3, configure S3 in AGFS and point `AGFS_ROOT_PATH` at the mounted S3 path, for example `/s3fs/getagents`.

## CLI Upload

The Agents page generates upload/update commands after the required agent information is filled in.

Example:

```bash
GETAGENTS_API_KEY=user-xxx bash <(curl -fsSL http://localhost:3000/getagents/cli/upload.sh) \
  --name 'My Agent' \
  --description 'What this agent does'
```

The script compresses the current working directory and uploads it as a ZIP package.

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
- `ADMIN_API_KEY`
- `SQL_DSN`, if using MySQL
- `STORAGE_DRIVER`, `AGFS_API_URL`, and `AGFS_ROOT_PATH`, if using AGFS storage
