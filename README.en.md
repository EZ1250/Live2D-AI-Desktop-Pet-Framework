# Pet

Electron-based Live2D desktop pet: model switching, chat, voice input, todos and plugins.

[简体中文](README.md) | **English**

## Run

Double-click the installed shortcut, or from source:

```bash
npm install
npm start
```

## Dependencies

- Runtime: `active-win` (active window detection)
- Dev: `electron`, `electron-builder`, `typescript`, `@types/node`
- Bundled Live2D runtime: PIXI + Cubism Core (source in `src/renderer/lib`)

## Development (advanced commands)

> Everyday install/start/package commands are listed above; the commands below are for debugging and pet-specific module tests.

### Renderer Console (UI / gaze / clicks / avatar stream)

```powershell
# Auto-open DevTools
$env:DEVTOOLS=1
& "$env:LOCALAPPDATA\Programs\Pet\Pet.exe"

# Remote debugging (open http://127.0.0.1:9222 in a browser)
& "$env:LOCALAPPDATA\Programs\Pet\Pet.exe" --remote-debugging-port=9222
```

### Pet-specific module tests

```bash
npm test                                          # tsc + assemble + all node:test
npm run check                                     # CI (tsc + assemble + node --test)
node --test tests/mcpServerPhone.test.js          # phone bridge / polling / timeout
node --test tests/mcpServerPhoneContracts.test.js # phone JSON contracts
node --test tests/mcpServerRemote.test.js         # remote MCP / WebSocket
node --test tests/live2dPlacement.test.js         # framing / head anchor
node --test tests/behaviorTriggers.test.js        # gaze follow, click/drag
node --test tests/autonomy.test.js                # autonomous task rules
node --test tests/promptLayers.test.js            # layered prompts
node --test tests/toolLoopGuard.test.js           # tool loop guard
node --test tests/mcpClient.test.js               # MCP client
node --test tests/voiceInput.test.js              # voice input
node --test tests/contracts.test.js               # cross-process contracts
```

### Packaging & acceptance

```bash
npm run check:privacy --all   # privacy boundary
npm run dist                  # installer + portable
npm run build:all             # compile/assemble only
```
