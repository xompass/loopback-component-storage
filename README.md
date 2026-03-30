# LoopBack Component Storage

Modernized fork of `loopback-component-storage` for LoopBack 3 projects that
only need:

- `filesystem`
- `s3` / `aws` / `amazon`

This fork removes `pkgcloud`, `formidable`, `strong-globalize`, and the legacy
provider matrix. The package is now implemented in TypeScript and keeps the
LoopBack 3 connector surface.

## Stack

- TypeScript `6.0.2`
- `@fastify/busboy` for streaming multipart parsing
- AWS SDK for JavaScript v3 for S3
- `tsdown` for builds
- `vitest` for tests
- `oxlint` for linting

## Behavior

- Uploads are streamed end to end.
- When `maxFileSize` is exceeded, the request is aborted immediately.
- Filesystem uploads do not buffer the full body in memory.
- S3 uploads use AWS SDK v3 multipart upload support.
- Signed URLs validate object existence before signing by default. Set
  `signedUrl.validateBeforeSign` to `false` to skip the extra `HeadObject`
  request.
- Filesystem signed URLs are local application URLs signed with HMAC. They
  require `signedUrl.secret`.

## Supported upload options

- `getFilename`
- `nameConflict: "makeUnique"`
- `allowedContentTypes`
- `maxFileSize`
- `maxFieldsSize`
- `acl`
- `StorageClass`
- `CacheControl`
- `ServerSideEncryption`
- `SSEKMSKeyId`
- `SSECustomerAlgorithm`
- `SSECustomerKey`
- `SSECustomerKeyMD5`

## S3 client tuning

For S3 datasources you can also tune the AWS SDK v3 client:

- `maxAttempts`
- `retryMode`
- `connectionTimeout`
- `requestTimeout`
- `socketTimeout`
- `throwOnRequestTimeout`
- `maxSockets`

Example:

```json
{
  "name": "storage",
  "connector": "@xompass/loopback-component-storage",
  "provider": "s3",
  "region": "us-east-1",
  "maxAttempts": 3,
  "retryMode": "standard",
  "connectionTimeout": 2000,
  "requestTimeout": 30000,
  "socketTimeout": 30000,
  "throwOnRequestTimeout": true,
  "maxSockets": 50
}
```

## Datasource examples

Filesystem:

```json
{
  "name": "storage",
  "connector": "@xompass/loopback-component-storage",
  "provider": "filesystem",
  "root": "./storage",
  "maxFileSize": 10485760,
  "maxFieldsSize": 1048576,
  "signedUrl": {
    "enabled": true,
    "expiresIn": 900,
    "secret": "replace-this-with-a-long-random-secret",
    "baseUrl": "https://api.example.com"
  }
}
```

AWS S3:

```json
{
  "name": "storage",
  "connector": "@xompass/loopback-component-storage",
  "provider": "s3",
  "region": "us-east-1",
  "accessKeyId": "YOUR_ACCESS_KEY",
  "secretAccessKey": "YOUR_SECRET_KEY",
  "CacheControl": "max-age=300",
  "signedUrl": {
    "enabled": true,
    "expiresIn": 900,
    "strategy": "provider",
    "validateBeforeSign": true
  },
  "maxAttempts": 3,
  "retryMode": "standard",
  "connectionTimeout": 2000,
  "requestTimeout": 30000,
  "socketTimeout": 30000,
  "throwOnRequestTimeout": true,
  "maxSockets": 50
}
```

MinIO or local S3-compatible storage:

```json
{
  "name": "storage",
  "connector": "@xompass/loopback-component-storage",
  "provider": "amazon",
  "region": "us-east-1",
  "endpoint": "http://localhost:9000",
  "forcePathStyle": true,
  "keyId": "MINIO_ACCESS_KEY",
  "key": "MINIO_SECRET_KEY",
  "CacheControl": "max-age=300",
  "signedUrl": {
    "enabled": true,
    "expiresIn": 1800,
    "strategy": "provider",
    "validateBeforeSign": false
  },
  "requestTimeout": 20000
}
```

Dedicated datasource with signed URLs enabled:

```json
{
  "AssetStorage": {
    "name": "AssetStorage",
    "connector": "@xompass/loopback-component-storage",
    "provider": "amazon",
    "region": "us-west-1",
    "endpoint": "http://localhost:9000",
    "forcePathStyle": true,
    "keyId": "${S3_ACCESS_KEY_ID_WEST_1}",
    "key": "${S3_SECRET_ACCESS_KEY_WEST_1}",
    "CacheControl": "max-age=300",
  "signedUrl": {
    "enabled": true,
    "expiresIn": 1800,
    "strategy": "provider",
    "validateBeforeSign": true
  },
    "maxAttempts": 2,
    "requestTimeout": 20000
  }
}
```

`signedUrl` is only used when the download request includes `?signedUrl=true`
or `?signed-url=true`.

For S3-compatible providers:

- `signedUrl.strategy: "provider"` keeps the current behavior and returns a
  presigned URL from S3 or the compatible backend
- `signedUrl.strategy: "local"` returns a signed URL from your own app instead
  of exposing the backend URL; that URL hits the component and streams the file
  through your server
- when `signedUrl.strategy` is `"local"`, `signedUrl.secret` is required
  because the component signs and validates the local URL itself
- you can override the datasource strategy per request via
  `signedUrlStrategy=local|provider` or `signed-url-strategy=local|provider`
- when calling `getSignedUrl()` or `download()` from code, you can pass an
  options object like `{ strategy: "local" }`; that explicit option has higher
  priority than both the query string and the datasource configuration

For filesystem providers:

- `signedUrl.secret` is required to generate and validate local signed URLs
- `signedUrl.baseUrl` is optional and lets you force the public origin used in
  generated URLs when the app is behind a proxy
- signed filesystem URLs now prefer `/:container/signed-download?file=...`
  with `expires` and `signature` query params
- `/:container/download/:file(*)` and
  `/:container/signed-download/:file(*)` are still supported for compatibility
- the current request query string is preserved except for signing-related and
  sensitive params such as `signedUrl`, `signed-url`, `signature`, `expires`,
  and anything that looks like tokens, secrets, passwords, authorization, API
  keys, or AWS presign parameters

This allows you to keep `/:container/download` protected and expose only
`/:container/signed-download` as a public route that validates the signature
before streaming the file. The target file can be provided as a query string
like `?file=projects/project-1/event-summaries/2026-03-29.json.gz`.

Example S3 datasource that always returns app-local signed URLs:

```json
{
  "name": "storage",
  "connector": "@xompass/loopback-component-storage",
  "provider": "amazon",
  "region": "us-east-1",
  "endpoint": "http://localhost:9000",
  "forcePathStyle": true,
  "keyId": "MINIO_ACCESS_KEY",
  "key": "MINIO_SECRET_KEY",
  "signedUrl": {
    "enabled": true,
    "expiresIn": 1800,
    "strategy": "local",
    "secret": "replace-this-with-a-long-random-secret",
    "baseUrl": "https://api.example.com",
    "validateBeforeSign": true
  }
}
```

## Migration notes from legacy pkgcloud-style configs

- `forcePathBucket` -> `forcePathStyle`
- `maxRetries` -> `maxAttempts`
- `defaultUploadParams.CacheControl` -> `CacheControl`
- `signatureVersion` is no longer used
- `protocol` is no longer used; include the protocol directly in `endpoint`
- `httpOptions.timeout` -> `requestTimeout`
- `httpOptions.agent.keepAlive` is not needed because AWS SDK v3 already reuses
  connections by default

When using custom S3-compatible endpoints, `endpoint` should usually point to
the service root, for example `http://localhost:9000`, not to a bucket URL such
as `http://localhost:9000/my-bucket`.

## Development

```bash
npm run lint
npm run typecheck
npm run build
npm test
```
