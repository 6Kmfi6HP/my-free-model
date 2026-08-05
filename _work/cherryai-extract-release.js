#!/usr/bin/env node
/**
 * CherryAI 密钥 —— 从 GitHub Releases 发布包自动提取
 *
 * 不依赖本机已安装的 Cherry Studio：直接从 CherryHQ/cherry-studio 的
 * release 资产下载安装包，解包定位 app.asar，再复用 cherryai-secret.js
 * 的密钥识别逻辑还原完整 HMAC 签名密钥。
 *
 * 支持的资产格式与解包方式：
 *   .zip    → unzip                     （macOS / 便携版）
 *   .dmg    → hdiutil attach + ditto    （macOS）
 *   .exe    → 7z（p7zip / npx 7zip-bin）（Windows NSIS）
 *   .AppImage → --appimage-extract      （Linux）
 *   .deb    → dpkg-deb -x 或 ar+tar     （Linux）
 *
 * 用法：
 *   node cherryai-extract-release.js                       # latest + 自动平台
 *   node cherryai-extract-release.js --tag v2.0.0
 *   node cherryai-extract-release.js --platform win32      # darwin|win32|linux
 *   node cherryai-extract-release.js --asset <文件名>      # 精确指定资产
 *   node cherryai-extract-release.js --url <直链>          # 直接给下载地址
 *   node cherryai-extract-release.js --out <路径>          # 密钥输出文件（默认 release-keys.json）
 *   node cherryai-extract-release.js --keep                # 保留下载/解包产物
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { extractMainJsFromAsar, parseSecret } from './cherryai-secret.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = 'CherryHQ/cherry-studio'

function log(...a) { console.log('[release]', ...a) }
function mask(s) { return s.slice(0, 6) + '…' + s.slice(-6) + ` (len=${s.length})` }

/* ---------- 参数解析 ---------- */
function parseArgs(argv) {
  const opts = { platform: guessPlatform(), keep: false, out: path.join(__dirname, 'release-keys.json') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--tag') opts.tag = next()
    else if (a === '--platform') opts.platform = next()
    else if (a === '--asset') opts.asset = next()
    else if (a === '--url') opts.url = next()
    else if (a === '--out') opts.out = path.resolve(next())
    else if (a === '--keep') opts.keep = true
    else if (a === '--help') { opts.help = true }
    else throw new Error(`未知参数: ${a}`)
  }
  return opts
}

function guessPlatform() {
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'win32') return 'win32'
  return 'linux'
}

/* ---------- GitHub API ---------- */
function releaseApiPath(tag) {
  // latest → /releases/latest；指定 tag → /releases/tags/vX.Y.Z
  if (!tag || tag === 'latest') return `repos/${REPO}/releases/latest`
  return `repos/${REPO}/releases/tags/${tag}`
}

async function getReleaseMeta(tag) {
  const apiPath = releaseApiPath(tag)
  const url = `https://api.github.com/${apiPath}`
  log(`获取 release 元数据: ${url}`)
  // 有 token 走 REST；否则优先 gh（本地已登录凭据）
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    const r = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'cherryai-extract',
      },
    })
    if (!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text()}`)
    return r.json()
  }
  const gh = spawnSync('gh', ['api', apiPath, '--jq', '.'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  if (gh.status !== 0) throw new Error(`gh api 失败: ${gh.stderr || gh.stdout}`)
  return JSON.parse(gh.stdout)
}

/* ---------- 资产选择 ---------- */
const PLATFORM_PREF = {
  darwin: [['.dmg'], ['.zip']],
  win32: [['-portable.exe'], ['-setup.exe']],
  linux: [['.AppImage'], ['.deb']],
}

function pickAsset(meta, { platform, assetName }) {
  const assets = meta.assets || []
  if (assetName) {
    const hit = assets.find((a) => a.name === assetName)
    if (!hit) throw new Error(`资产不存在: ${assetName}`)
    return hit
  }
  const prefs = PLATFORM_PREF[platform]
  if (!prefs) throw new Error(`未知平台: ${platform}`)

  // 同后缀多架构时优先 x64/amd64（适配 ubuntu-latest）
  const archScore = (name) => {
    const n = name.toLowerCase()
    if (n.includes('x64') || n.includes('amd64') || n.includes('x86_64')) return 0
    if (n.includes('arm64') || n.includes('aarch64')) return 2
    return 1
  }

  for (const pats of prefs) {
    for (const p of pats) {
      const hits = assets.filter((a) => a.name.endsWith(p)).sort((a, b) => archScore(a.name) - archScore(b.name))
      if (hits.length) return hits[0]
    }
  }
  throw new Error(`平台 ${platform} 没有可识别的资产，请用 --asset 指定`)
}

/* ---------- 下载 ---------- */
async function download(url, dest) {
  log(`下载 ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${await res.text()}`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(dest, buf)
  log(`已下载 ${(buf.length / 1048576).toFixed(1)} MiB → ${dest}`)
}

/* ---------- 解包 ---------- */
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} 失败: ${r.stderr || r.stdout}`)
  return r.stdout
}

function extractZip(file, dir) {
  sh('unzip', ['-q', '-o', file, '-d', dir])
}

function extractDmg(file, dir) {
  if (process.platform !== 'darwin') throw new Error('dmg 仅在 macOS 上可解包')
  const out = sh('hdiutil', ['attach', file, '-nobrowse', '-readonly', '-plist'], { encoding: 'utf8' })
  // plist 里取 mount-point
  const mp = (out.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/) || [])[1]
  if (!mp) throw new Error('无法解析 dmg 挂载点')
  try {
    const apps = fs.readdirSync(mp).filter((f) => f.endsWith('.app'))
    const app = apps.find((f) => f.toLowerCase().includes('cherry')) || apps[0]
    if (!app) throw new Error('dmg 内没有 .app')
    sh('ditto', [path.join(mp, app), path.join(dir, app)])
    log(`已从 dmg 拷贝 ${app}`)
  } finally {
    sh('hdiutil', ['detach', mp, '-quiet'])
  }
}

function find7z() {
  for (const name of ['7z', '7za', '7zz', '7zr']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' })
    if (r.status === 0) return name
  }
  // 兜底：npx 临时安装 7zip-bin，取其二进制路径
  const r = spawnSync('npx', ['--yes', '-p', '7zip-bin', 'node', '-e', 'process.stdout.write(require("7zip-bin").path7za)'],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120000 })
  if (r.status !== 0 || !r.stdout) throw new Error('未找到 7z，请 brew install p7zip 或安装 7zip-bin')
  return r.stdout.trim()
}

function extractExe(file, dir) {
  const z = find7z()
  fs.mkdirSync(dir, { recursive: true })
  sh(z, ['x', '-y', `-o${dir}`, file])
}

function extractAppImage(file, dir) {
  fs.chmodSync(file, 0o755)
  sh(file, ['--appimage-extract'], { cwd: dir })
}

function extractDeb(file, dir) {
  const dpkg = spawnSync('which', ['dpkg-deb'], { encoding: 'utf8' })
  if (dpkg.status === 0) {
    sh('dpkg-deb', ['-x', file, dir])
  } else {
    // 兜底：ar x + tar
    fs.mkdirSync(path.join(dir, '_deb'), { recursive: true })
    sh('ar', ['x', file], { cwd: path.join(dir, '_deb') })
    const data = fs.readdirSync(path.join(dir, '_deb')).find((f) => f.startsWith('data.tar'))
    sh('tar', ['xf', path.join(dir, '_deb', data), '-C', dir])
  }
}

function extractAsset(file, dir) {
  const ext = path.extname(file).toLowerCase()
  const base = path.basename(file)
  if (ext === '.zip') return extractZip(file, dir)
  if (ext === '.dmg') return extractDmg(file, dir)
  if (ext === '.exe') return extractExe(file, dir)
  if (base.endsWith('.AppImage')) return extractAppImage(file, dir)
  if (ext === '.deb') return extractDeb(file, dir)
  throw new Error(`暂不支持的资产格式: ${file}`)
}

/* ---------- 定位 app.asar ---------- */
function findAsar(dir, depth = 0) {
  if (depth > 6) return null
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = findAsar(p, depth + 1)
      if (hit) return hit
    } else if (entry.name === 'app.asar') {
      return p
    }
  }
  return null
}

/* ---------- 主流程 ---------- */
async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { console.log(`用法见文件头注释`); return }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cherryai-release-'))
  log(`工作目录: ${work}`)

  let asset
  let releaseTag = opts.tag || 'latest'
  let downloadUrl = opts.url
  if (!downloadUrl) {
    const meta = await getReleaseMeta(opts.tag)
    releaseTag = meta.tag_name || releaseTag
    asset = pickAsset(meta, { platform: opts.platform, assetName: opts.asset })
    downloadUrl = asset.browser_download_url
    log(`选择资产: ${asset.name}  (${(asset.size / 1048576).toFixed(0)} MiB)`)
  } else {
    log(`直接使用 URL: ${downloadUrl}`)
  }

  const fileName = path.basename(new URL(downloadUrl).pathname) || 'pkg.bin'
  const filePath = path.join(work, fileName)
  await download(downloadUrl, filePath)

  const extractDir = path.join(work, 'x')
  log(`解包 ${fileName} …`)
  extractAsset(filePath, extractDir)

  const asar = findAsar(extractDir)
  if (!asar) throw new Error('解包后未找到 app.asar')
  log(`找到 app.asar: ${asar}`)

  const mainJs = extractMainJsFromAsar(asar, path.join(work, 'asar'))
  const secret = parseSecret(mainJs)

  log(`tag/platform : ${releaseTag} / ${opts.platform}`)
  log(`clientId     : ${secret.clientId}`)
  log(`baseUrl      : ${secret.baseUrl}`)
  log(`prefix       : ${mask(secret.prefix)}`)
  log(`suffix       : ${mask(secret.suffix)}`)
  log(`fullSecret   : ${mask(secret.fullSecret)}`)
  log(`main.js      : ${mainJs}`)

  const payload = {
    ...secret,
    fullSecret: secret.fullSecret,
    tag: releaseTag,
    platform: opts.platform,
    asset: asset?.name || fileName,
  }
  fs.mkdirSync(path.dirname(opts.out), { recursive: true })
  fs.writeFileSync(opts.out, JSON.stringify(payload, null, 2) + '\n')
  log(`密钥已写入: ${opts.out}`)
  // CI 用：把解析出的 tag 写到 GITHUB_OUTPUT
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${releaseTag}\nasset=${payload.asset}\n`)
  }

  if (!opts.keep) fs.rmSync(work, { recursive: true, force: true })
}

main().catch((e) => { console.error('[release] 失败:', e.message); process.exit(1) })
