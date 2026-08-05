# 免费模型提取 · prototype

理解并复现 Cherry Studio「CherryAI / Qwen」免费模型的请求协议，从本地安装
自动提取完整签名密钥，并发送**真实**请求获得 AI 回复 —— 已实测通过。

## 结论（实测）

| 项 | 值 |
|----|----|
| Endpoint | `POST https://api.cherry-ai.com/chat/completions` |
| Model | `qwen` |
| 客户端 ID | `cherry-studio` |
| 鉴权 | 客户端 HMAC-SHA256 签名（**无需** API Key / Bearer） |
| 完整密钥 | 内置在 `app.asar` → `out/main/main.js`（非空，可直接提取） |
| 结果 | `HTTP 200`，返回真实 Qwen 文本与流式输出 |

## 签名算法

canonical 为六段换行连接，随后 `HMAC-SHA256(secret, canonical).hex()`：

```
method(UPPER)\n path \n query \n clientId \n timestamp \n body
```

返回头：`X-Client-ID` / `X-Timestamp` / `X-Signature`。
请求体与签名必须使用**完全相同**的 JSON 字符串。

## 密钥在哪

打包产物 `out/main/main.js` 中内联了：

```js
CLIENT_SECRET = "K3RN…(64)";                 // 前缀
getClientSecret() { return CLIENT_SECRET + ".GvI6…(64)"; }  // 后缀
```

> 注意：任务描述称前后两半之一在 GitHub Actions 注入、仓库不公开；
> **但官方 Release 构建会把两半都内联进 main.js**，因此本地安装可直接还原出
> `完整密钥 = 前缀 + "." + 后缀`。仅克隆开源源码仓库看不到它，读取本地 app 能看到。

## 文件

- `cherryai-secret.js` — 密钥识别核心（定位 app.asar → 提取 → 正则抓两半 → 拼装）
- `cherryai-request.js` — 真实请求脚本（复用提取器做签名，支持 `--stream`）
- `cherryai-extract-release.js` — **从 GitHub Releases 发布包自动提取**（见下）

## 用法

```bash
node cherryai-request.js "你好"            # 非流式
node cherryai-request.js --stream "你好"   # 流式（SSE）
CHERRY_STUDIO_APP=/path/to/Cherry Studio.app node cherryai-request.js "xx"
```

## GitHub Actions 自动提取

工作流 [`.github/workflows/extract-keys.yml`](../.github/workflows/extract-keys.yml)
在 CI 中跑同一套提取脚本，把结果写回仓库的 `_work/release-keys.json`：

| 触发 | 说明 |
|------|------|
| `schedule` | 每 12 小时拉一次最新 Release |
| `workflow_dispatch` | 手动触发；可填 `tag` / `platform` |

CI 默认用 `ubuntu-latest` + `--platform win32`（`p7zip` 解 NSIS portable），
避免 macOS dmg / AppImage FUSE 依赖；同一版本密钥跨平台一致。

密钥有变更时，`github-actions[bot]` 自动 commit + push。首次启用前需保证
Actions 对默认分支有写权限（Settings → Actions → Workflow permissions → Read and write）。

## 从 Release 发布包提取（不依赖本机已安装）

`cherryai-extract-release.js` 直接从 CherryHQ/cherry-studio 的 GitHub Releases
下载安装包，自动解包定位 `app.asar` 并还原密钥，密钥写入 `release-keys.json`。

```bash
node cherryai-extract-release.js                        # latest + 自动识别平台
node cherryai-extract-release.js --tag v2.0.0           # 指定版本
node cherryai-extract-release.js --platform win32       # darwin|win32|linux
node cherryai-extract-release.js --asset <文件名>       # 精确指定 release 资产
node cherryai-extract-release.js --url <直链>           # 直接给下载地址
node cherryai-extract-release.js --out <路径>           # 密钥输出文件
node cherryai-extract-release.js --keep                 # 保留临时下载/解包产物
```

支持的资产格式与解包方式：

| 格式 | 方式 | 平台 |
|------|------|------|
| `.zip` | `unzip` | macOS 便携 / 通用 |
| `.dmg` | `hdiutil attach` + `ditto` | macOS（仅 macOS 本机） |
| `.exe` | `7z`（p7zip 或 `npx 7zip-bin`） | Windows NSIS |
| `.AppImage` | `--appimage-extract` | Linux |
| `.deb` | `dpkg-deb -x` 或 `ar`+`tar` 兜底 | Linux |

release 资产选择优先级：darwin → `.dmg` → `.zip`；win32 → `-portable.exe` →
`-setup.exe`；linux → `.AppImage` → `.deb`。

### 已实测

`--asset Cherry-Studio-2.0.0-arm64.zip`（306 MiB）：下载 → 解包 → 定位
`Cherry Studio.app/Contents/Resources/app.asar` → 提取成功，密钥与本地安装
完全一致（`K3RN…qys0g`, len=129）。

## 说明

仅用于理解 Cherry Studio 免费模型在本地客户端的鉴权/请求原理，并在本人机器上
验证协议正确性。密钥提取自官方分发的客户端产物（本地安装或 Release 包）。
