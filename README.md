# free-model

从 Cherry Studio 官方 Release 自动提取 CherryAI 免费模型 HMAC 签名密钥。

- 提取脚本与说明：[`_work/`](_work/)
- 密钥文件：[`_work/release-keys.json`](_work/release-keys.json)
- 自动化：每 12 小时 / 手动触发 → [Extract CherryAI Keys](.github/workflows/extract-keys.yml)

启用 Actions 后，到 **Settings → Actions → General → Workflow permissions** 勾选
**Read and write permissions**，否则无法把更新后的密钥 push 回仓库。
