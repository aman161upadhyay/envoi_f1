# One official Envoi plugin

The owner decision is one official plugin for Je, Rachel and customers. Do not ask customers to create custom MCP plugins, install a different demo package, or change publisher code. Each owner installs the available official plugin and approves their own Envoi OAuth connection.

## Publisher responsibilities

Keep the existing official plugin and App identity through its supported authoring/release process. The current personal `Envoi production` plugin is `plugin_asdk_app_6ae4b1eeb69481918c65e9c8d90f3928`, bound to `asdk_app_6ae4b1eeb69481918c65e9c8d90f3928`. Its observed audience is USER/PRIVATE; it is not evidence of a public listing or Rachel's access. Correct shared/workspace or public availability separately, then verify that a second owner can install that exact official plugin. Use the resulting verified installation link in customer onboarding when available; do not invent a listing URL.

The official connection needs production `https://www.envoi-agents.com/mcp`, OAuth and explicit `baseScopes: ["envoi.agent", "envoi.send"]` for two-way agent messaging. `chatgpt-mcp.example.json` contains the portable configuration reference. This is publisher configuration, not a customer setting. Preserve existing client registration unless a supported migration is reviewed. The server already advertises both scopes; do not broaden its defaults to bypass an explicitly narrow client request. Confirm the actual request and owner approval offer both message permissions.

The available App-backed archive editor can update skills and onboarding selection but must preserve App-owned connection configuration, title, presentation and audience. Adding `mcp.json` to that archive is not a supported repair of its existing connection. Locate the original owning editor or release source. If it cannot update OAuth configuration in place, record the platform limitation and resolve the supported migration with the publisher/platform before promising this same identity is repaired. Do not create a private workaround.

Use `plugin/skills/envoi-dots-setup/SKILL.md` as the official onboarding skill. It checks an existing connection first, keeps the same identity, distinguishes missing scope from action approval, and requires actual send and work receipts. Installing the skill does not change OAuth scopes or distribution.

For a Developer Portal-managed submission, [OpenAI's submission documentation](https://developers.openai.com/plugins/deploy/submission#configure-authentication-for-submission) places advanced OAuth configuration in the package's `mcp.json`; use Upload new version and inspect the saved MCP settings. That guidance does not establish that the current personal App-backed plugin has a Portal-managed source or supports conversion in place. Public review and publication remain publisher actions.

## Owner responsibilities

After the official release/configuration is verified, Je reconnects Onion and Rachel reconnects Delta in their own ChatGPT accounts. Choose the existing identity and explicitly select Send during consent. Verify the exact address, both message permissions and both send tools. No customer needs access to the source repository or publisher settings. Follow `DEMO.md` for the two-owner exchange and `DOTS-HOSTED-ACCEPTANCE.md` for hosted evidence.
