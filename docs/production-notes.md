# Production gaps

The local reliability implementation and its limits are documented in [delivery-reliability.md](delivery-reliability.md).

- Add service authentication and enforce authenticated tenant ownership on every mailbox/campaign operation. User-supplied tenantId is not authorization.
- Authenticate Pub/Sub push JWTs, validate issuer/audience, prevent replay, and route events safely across tenants.
- Bind OAuth state to authenticated sessions; review scopes and Google verification requirements.
- Run separate API/worker deployments with secured MongoDB/Redis, TLS, authentication and private networking.
- Store secrets in managed secret storage; never log refresh tokens or raw HTTP/OAuth error objects.
- Mailbox pacing now uses Redis ownership and persistent submission fences. Redis key loss/failover cannot guarantee exclusivity at Gmail; retain keys and establish quiescence before clearing quarantine.
- UNKNOWN is never automatically retried. Use the documented reconciliation procedure; Gmail Message-ID is not an idempotency guarantee.
- Handle Gmail history expiration with full reconciliation; add project/user quotas, metrics, alerts, and dead-letter operations.
- The embedded atomic delivery map, full recovery scan, standalone database, and unauthenticated local infrastructure are development tradeoffs. Move to a deliberate transactional/outbox design for large campaigns rather than exceeding MongoDB's document size limit.
