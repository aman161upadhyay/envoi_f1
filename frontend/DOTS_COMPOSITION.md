# Dots production composition

Current base: origin/main atf9233dd4e4f4eab7861c03c2778ab20a48ff03bd. Preserve its named-owner quota, inbox-visibility and WorkOS read-performance changes. Earlier e66e71a/af0392a release proposals are superseded and have not been promoted by this task. Candidate71d2342 passed complete hosted CI on the previous9cb base; the combined current-main tree must pass complete exact-candidate CI again.

This composition carries the already human-approved message-access contract v1 revision2: the read-only recovery action requires envoi.agent, while its native consent challenge still requests envoi.agent plus envoi.send. Actual Send enforcement, permission-filtered discovery and forbidden responses remain unchanged.

Setup verifies and reuses an intended ready connection before OAuth, stops on identity mismatch or service errors, distinguishes missing tools from missing grants, and stays in the current Dot conversation. The main permissions editor blocks repeating a refused OAuth scope expansion and offers same-agent recovery. Recovery and verification text remain selectable when clipboard access fails. Integration has a different permission-editor structure, so this main-specific change is composed separately.

A separate production deployment on2026-11-05 disabled all six live Dots flags and cleared the callback origin. The owner restored those values on current9cb code. Synchronize only those seven beta vars in wrangler.jsonc; keep staging, global server defaults, namespaces, routes, secrets and other flags unchanged. Deployment validation now rejects any regression to disabled values. Production smoke also checks actual OAuth/on-demand route availability: healthy /health and /ready responses alone do not establish that Dots is available.

The normal guarded npm run cf:deploy:beta command is retained. The unreleased custom deployment-profile design and its own introduced tests were retired in favor of recording the intended beta state in the existing source configuration. All pre-existing release guards remain. Legacy core-only promotion profiles intentionally narrow features and are not the current Dots production configuration.

Monitoring instructions reuse an existing matching task and drain matching work serially in batches of at most10 because hints can coalesce. They stop on unrelated work, approval or errors and avoid replies to acknowledgements. A flag-off startup can invalidate old backend subscriptions even while host tasks show enabled; after restoration renew/re-register the existing event source, or disable the old monitor before creating one replacement. No agent identity or history is replaced by this source release.

Both owners completed real manual native messaging, but native wake/claim/reply/completion acceptance remains pending. Their current installed Apps are distinct DEVELOPMENT Apps on the same server. Envoi Business was selected for one canonical public release, but business verification, public support/policy pages and review materials remain incomplete. No new private demo plugin or public publication is implied.

Build web only with npm run build on this exact composition. Complete source and exact-candidate CI plus a bounded human release exception are required before promotion or deployment. Do not use an old candidate to overwrite current main.
