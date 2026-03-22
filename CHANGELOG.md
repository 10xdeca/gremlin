# Changelog

## [1.1.0](https://github.com/10xdeca/gremlin/compare/v1.0.0...v1.1.0) (2026-03-22)


### Features

* background contact scanner and reply-to-image vision ([#70](https://github.com/10xdeca/gremlin/issues/70)) ([#77](https://github.com/10xdeca/gremlin/issues/77)) ([18e8e1d](https://github.com/10xdeca/gremlin/commit/18e8e1d52c0e0a4d85de78f62307d195db88e078))
* DM onboarding for new group members with Radicale contacts ([#68](https://github.com/10xdeca/gremlin/issues/68)) ([d2e406c](https://github.com/10xdeca/gremlin/commit/d2e406c165023b868c4ce569c47867177a8213cc))
* inject team roster into system prompt for instant user lookups ([#67](https://github.com/10xdeca/gremlin/issues/67)) ([a3db786](https://github.com/10xdeca/gremlin/commit/a3db786010120949ee4e3fe54fc9648e9d50f924))
* webhook mode with graceful fallback to polling ([651f9cb](https://github.com/10xdeca/gremlin/commit/651f9cb01577e08595facf6b619d20e6175a63eb))


### Bug Fixes

* call webhookCallback after setWebhook to avoid poisoning bot.start ([31cbff3](https://github.com/10xdeca/gremlin/commit/31cbff39db199ef2a2e00d5b7e36409803903c54))
* catch 409 polling conflicts instead of crashing ([6c6bb0c](https://github.com/10xdeca/gremlin/commit/6c6bb0c1c67b39a378e9c7f6c397c4826886bae6))
* catch 409 polling crash via process unhandledRejection handler ([bbbc332](https://github.com/10xdeca/gremlin/commit/bbbc332d87728f26c6a6df6f08f89d3ed9e5ac02))
* clear previous polling session before starting ([7f342c2](https://github.com/10xdeca/gremlin/commit/7f342c2ecd59dfe2819df96b4e84ee6d526aa832))
* handle setMyCommands rate limit gracefully on startup ([1420342](https://github.com/10xdeca/gremlin/commit/142034264cb5c49eecd7bccef2f1f072e178457b))
* ignore own messages to prevent self-reply loop ([fbe89c4](https://github.com/10xdeca/gremlin/commit/fbe89c46022748261544da4a34e5102e3f1b8d18))
* let 409 crash process instead of silently killing polling loop ([58d851a](https://github.com/10xdeca/gremlin/commit/58d851a4ae5b5c50cd7b330d4dcd0e4f117db95f))
* prevent startup spam from crash loops and stale updates ([0022af3](https://github.com/10xdeca/gremlin/commit/0022af346b6093c6b6bcd89058a9adc322964ed4))
* probe Telegram connection before starting polling loop ([112804a](https://github.com/10xdeca/gremlin/commit/112804a5c8f474520a34b6c29291f81d49e85785))
* switch to Haiku 4.5 and update OAuth endpoint for outage recovery ([38620f4](https://github.com/10xdeca/gremlin/commit/38620f429a648628c1a8a69f1414af1ae01d24cd))
* update system prompt with correct GitHub tool names and remove ToolMaker ([#65](https://github.com/10xdeca/gremlin/issues/65)) ([8b8309f](https://github.com/10xdeca/gremlin/commit/8b8309f77bd901f6fd8ac407d76a548c15a42918))
* use blocklist for displayName sanitization to preserve i18n characters ([#69](https://github.com/10xdeca/gremlin/issues/69)) ([5f8b102](https://github.com/10xdeca/gremlin/commit/5f8b102befc0ac23150061ca144eaf185461ff01))

## 1.0.0 (2026-03-13)


### Features

* add [@mention](https://github.com/mention) task creation and interactive flow for passive detection ([#13](https://github.com/10xdeca/gremlin/issues/13)) ([65b084a](https://github.com/10xdeca/gremlin/commit/65b084ab75af84ccaede06125e4e5f8f7f1e00b5))
* add A2A research agent integration ([#30](https://github.com/10xdeca/gremlin/issues/30)) ([b3e930e](https://github.com/10xdeca/gremlin/commit/b3e930eb2201a79c73ed42c7978a592ec945bb2f))
* add async daily standups (Phase 1) ([#25](https://github.com/10xdeca/gremlin/issues/25)) ([dab8b40](https://github.com/10xdeca/gremlin/commit/dab8b40bea198d56b6ecfef4e9a547ee77661ff1))
* add calendar event reminders via Radicale ([#29](https://github.com/10xdeca/gremlin/issues/29)) ([e4e9d87](https://github.com/10xdeca/gremlin/commit/e4e9d871c1501e0a241461b0513f70f35deb760e))
* add card creation, [@mention](https://github.com/mention) assignment, and LLM task detection ([#12](https://github.com/10xdeca/gremlin/issues/12)) ([df66fe2](https://github.com/10xdeca/gremlin/commit/df66fe29f70951773c615ebe145af6e0d138f086))
* add deploy diff tool so bot can report its own code changes ([#37](https://github.com/10xdeca/gremlin/issues/37)) ([edfa610](https://github.com/10xdeca/gremlin/commit/edfa61014408d8a570a5d82c2dc15ba2d205c0dc))
* add GitHub issue tools (create and list) ([#64](https://github.com/10xdeca/gremlin/issues/64)) ([54559bb](https://github.com/10xdeca/gremlin/commit/54559bbb4df37a3fb702e132546d0dc0f934e323))
* add GitHub repo tools for code reading ([#63](https://github.com/10xdeca/gremlin/issues/63)) ([e75614b](https://github.com/10xdeca/gremlin/commit/e75614bf88b98a64415842bf2c8023856f22b357))
* add Gremlin's Corner social topic with topic-aware behavior ([#51](https://github.com/10xdeca/gremlin/issues/51)) ([915adb1](https://github.com/10xdeca/gremlin/commit/915adb19e7da78dc92b52c518636f664f2440cc3))
* add image vision capability ([#46](https://github.com/10xdeca/gremlin/issues/46)) ([f48d963](https://github.com/10xdeca/gremlin/commit/f48d9631198616b996eca0471e0255577e5d6960))
* add Jake to survey + show completed respondents ([114add6](https://github.com/10xdeca/gremlin/commit/114add63eeb2378015919049312d408fa56f36fe))
* add meta-sprint review survey web app ([#47](https://github.com/10xdeca/gremlin/issues/47)) ([0e61238](https://github.com/10xdeca/gremlin/commit/0e61238df66318fed47920f2b7e456d990490cca))
* add movie quote personality to Gremlin's system prompt ([#48](https://github.com/10xdeca/gremlin/issues/48)) ([296e870](https://github.com/10xdeca/gremlin/commit/296e87004b2b66404c7ff233734ff2d0414c701f))
* add naming ceremony for bot identity selection ([#11](https://github.com/10xdeca/gremlin/issues/11)) ([19b18dc](https://github.com/10xdeca/gremlin/commit/19b18dc620971dca3fee78df6201421e926bdce3))
* add Playwright MCP server for web browsing ([#41](https://github.com/10xdeca/gremlin/issues/41)) ([3ac721a](https://github.com/10xdeca/gremlin/commit/3ac721a8ae90cc34bd770569a008f270f853f5ea))
* add self-diagnostics and self-repair tools ([#39](https://github.com/10xdeca/gremlin/issues/39)) ([e0bf144](https://github.com/10xdeca/gremlin/commit/e0bf14484b9c7caa20a407f76b37be212661d58d))
* add standup DM nudges for non-responders ([#27](https://github.com/10xdeca/gremlin/issues/27)) ([2a24f47](https://github.com/10xdeca/gremlin/commit/2a24f477c8708c7b6d78d31f79063a6b8d754db5))
* add token auth error classification, admin alerts, and health checks ([#38](https://github.com/10xdeca/gremlin/issues/38)) ([5561d0e](https://github.com/10xdeca/gremlin/commit/5561d0e693d716cce2435dfe1c697c9e53333ca1))
* add ToolMaker capability to system prompt ([#61](https://github.com/10xdeca/gremlin/issues/61)) ([9c13b19](https://github.com/10xdeca/gremlin/commit/9c13b1931ce1a4b1e7498b8f6a2ccda04ae67b25))
* add versioning, integration tests, smoke tests, and health check ([#58](https://github.com/10xdeca/gremlin/issues/58)) ([2810efa](https://github.com/10xdeca/gremlin/commit/2810efa8da24515ce71755790cf57ef0f27c4970))
* improve memory, add DMs, confine tasks to PM topic ([#52](https://github.com/10xdeca/gremlin/issues/52)) ([6b8e0de](https://github.com/10xdeca/gremlin/commit/6b8e0de4c2c6b3ae135693af40da9b6c32596622))
* integrate Radicale MCP server for CalDAV/CardDAV access ([c55ea12](https://github.com/10xdeca/gremlin/commit/c55ea12b4746220f99dc5c1f52cf852538efdf5a))
* pass RADICALE_CALENDAR_OWNER to radicale MCP server ([e028fcc](https://github.com/10xdeca/gremlin/commit/e028fcce43eef6844740fb8f6274786d3f345999))
* persist conversation history in SQLite + fix duplicate user mappings ([#42](https://github.com/10xdeca/gremlin/issues/42)) ([d92d5cf](https://github.com/10xdeca/gremlin/commit/d92d5cf994dca00f649692a06112ba7f2ce23358))
* persist OAuth refresh token to SQLite ([#19](https://github.com/10xdeca/gremlin/issues/19)) ([57a890b](https://github.com/10xdeca/gremlin/commit/57a890b89ed107038580ce53ce5cd385d4a713ce))
* prefill survey form for returning respondents ([3efef88](https://github.com/10xdeca/gremlin/commit/3efef8844d51dda570a4c51572f3c8884ea2c084))
* preserve tool call context in conversation history ([#43](https://github.com/10xdeca/gremlin/issues/43)) ([fc71160](https://github.com/10xdeca/gremlin/commit/fc71160f1fac9ee93b0c084d3dc2eeb2b803c2f3))
* require [@mention](https://github.com/mention) in non-primary topics ([#31](https://github.com/10xdeca/gremlin/issues/31)) ([b5e0eeb](https://github.com/10xdeca/gremlin/commit/b5e0eebd917176aaa1eee356ebdae236db5f493e))
* rewrite bot as full LLM agent with MCP tools ([#18](https://github.com/10xdeca/gremlin/issues/18)) ([3563a85](https://github.com/10xdeca/gremlin/commit/3563a851fc169ac5f7d1fcdda57842ed8b38efa7))
* route scheduler reminders through agent loop ([#44](https://github.com/10xdeca/gremlin/issues/44)) ([0ece8de](https://github.com/10xdeca/gremlin/commit/0ece8deb59ec837d4a55e627728c39b77424590a))
* run calendar check on startup ([4a891ad](https://github.com/10xdeca/gremlin/commit/4a891ad4a9226240472e0c489c47d71e232993f7))
* self-announce rebirth on startup via agent loop ([6659599](https://github.com/10xdeca/gremlin/commit/665959916463e7cfdec734521e2d70016701560c))
* share group chat memory into PM conversations ([#62](https://github.com/10xdeca/gremlin/issues/62)) ([1566127](https://github.com/10xdeca/gremlin/commit/156612789c11512e0af254dd2c5b074f87a683ae))
* support reply-with-pointer for task creation from existing messages ([#17](https://github.com/10xdeca/gremlin/issues/17)) ([05d568c](https://github.com/10xdeca/gremlin/commit/05d568c32bd8d2deb6c6c9054789733840de5112))


### Bug Fixes

* add --no-sandbox flag for Playwright in Docker ([69f2a1b](https://github.com/10xdeca/gremlin/commit/69f2a1bc52753582344b741981d26121a0a87d65))
* add tool call logging to agent loop ([adc7d1c](https://github.com/10xdeca/gremlin/commit/adc7d1c9c6b912d06c8b5166daedb89cf8927ae0))
* add workflow_dispatch trigger to release workflow ([19ec510](https://github.com/10xdeca/gremlin/commit/19ec510761a9d24655a386391a6d22560304a4bb))
* always check user mappings before claiming ignorance ([#50](https://github.com/10xdeca/gremlin/issues/50)) ([a354158](https://github.com/10xdeca/gremlin/commit/a354158a350476ece102b396cc9dae24026c2d55))
* auto-remove workspace links for unreachable Telegram chats ([39c9d8a](https://github.com/10xdeca/gremlin/commit/39c9d8a838c5f046e369a008dfb296409e6e1080))
* correct Claude Haiku model ID ([#10](https://github.com/10xdeca/gremlin/issues/10)) ([e15f696](https://github.com/10xdeca/gremlin/commit/e15f696f21e42543ed0b7959a36e682a83dfe8d0))
* correct Sonnet 4.6 model ID (no date suffix) ([7eda1ee](https://github.com/10xdeca/gremlin/commit/7eda1eee45d9dfdf2c404e8d82d04a4163e790ec))
* **deploy:** post arrival messages to Project Management topic ([#40](https://github.com/10xdeca/gremlin/issues/40)) ([70e19d8](https://github.com/10xdeca/gremlin/commit/70e19d8b78bd9edb27f5183fce1bc9203dbf28ff))
* expose health check port to host for deploy verification ([f7fd940](https://github.com/10xdeca/gremlin/commit/f7fd9407fa050056c798000d10cf47e21cc372c3))
* fall back to plain text when Telegram rejects Markdown ([#32](https://github.com/10xdeca/gremlin/issues/32)) ([34c3918](https://github.com/10xdeca/gremlin/commit/34c3918295c256728c942f11ce414103c70168a0))
* fetch board data once per workspace check cycle to avoid 429s ([#9](https://github.com/10xdeca/gremlin/issues/9)) ([5502c8d](https://github.com/10xdeca/gremlin/commit/5502c8de7cfdc2ad5f2e5db928e955a5d6b40a54))
* limit bot to configured topic in group chats ([#26](https://github.com/10xdeca/gremlin/issues/26)) ([ed2fce6](https://github.com/10xdeca/gremlin/commit/ed2fce643e69f26e6043ae20e063ac85277960bc))
* revert to GITHUB_TOKEN now that org allows workflow writes ([da0212d](https://github.com/10xdeca/gremlin/commit/da0212d2ca2c2bc0596a6e5d5fbae1ca8e8a2968))
* tell Gremlin it has conversation memory in system prompt ([#45](https://github.com/10xdeca/gremlin/issues/45)) ([7922524](https://github.com/10xdeca/gremlin/commit/792252424101b9bc18936229c0796a44ce191d7c))
* tone down movie quote frequency per Gremlin's feedback ([#49](https://github.com/10xdeca/gremlin/issues/49)) ([9375664](https://github.com/10xdeca/gremlin/commit/9375664cae74c2b7c37a4e0cae2e12f1dc6729b2))
* trigger CI on release-please branch pushes ([6ce3739](https://github.com/10xdeca/gremlin/commit/6ce3739b2098f0cad7836b85954541bc9c269c96))
* use PAT for release-please (org blocks default GITHUB_TOKEN writes) ([77525fb](https://github.com/10xdeca/gremlin/commit/77525fbf14a95b55e880ca53e80792c40e6a9240))
* use PAT for release-please to trigger CI on its PRs ([bd1bf8d](https://github.com/10xdeca/gremlin/commit/bd1bf8d6b506ee43196e3344230f5fc25f249b96))
