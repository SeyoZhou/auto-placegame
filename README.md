# PlaceGame 日常自动化

[简体中文](#简体中文) | [English](#english)

## 简体中文

这是一个基于 Node.js 的本地 PlaceGame 多账号自动化运行器，支持 macOS 和 Linux。

### 平台支持

运行器需要 Node.js 24 或更高版本。克隆仓库后可先检查账号状态或执行模拟运行：

```sh
node placegame-auto.mjs status
node placegame-auto.mjs run --dry-run
```

运行器会在本地维护私有 Session 文件，无需在每次执行时重新登录。

### 配置账号

使用现有的 `.placegame-accounts.local.json`，或以 `placegame-accounts.example.json` 为模板创建配置。`accounts` 中的多个账号会被分别处理。
账号别名会出现在报告中，因此请使用 `account-1` 之类不包含身份信息的本地标签；不要使用用户名、角色昵称或玩家 ID。

```sh
chmod 600 .placegame-accounts.local.json
```

运行器会拒绝符号链接、非普通文件、属于其他用户的文件，以及权限模式不是 `0600` 的凭据文件。

### 运行

```sh
node placegame-auto.mjs status
node placegame-auto.mjs run --dry-run
node placegame-auto.mjs idle
node placegame-auto.mjs daily
node placegame-auto.mjs arcade
node placegame-auto.mjs boss
node placegame-auto.mjs world-boss --dry-run
node placegame-auto.mjs run
```

使用 `--account account-1` 选择指定别名的账号，使用 `--json` 获取结构化输出。`run` 会依次执行挂机/地图维护、免费街机、个人首领和每日奖励。个人首领只使用共享的 5 次免费胜场，预测胜率不低于 10%，不使用门票，并开启素材加成来提升装备品质；每次胜利后会立即穿戴更优装备，再重新选择最弱部位，单轮最多提交 20 次挑战。每日奖励会领取签到、主线/支线、成就、图鉴、赛季、邮件、活跃宝箱和已达成的公会进度奖励，但不会自动捐献。

`world-boss` 是独立命令，只在北京时间 `10:00–11:00`、`16:00–17:00`、`20:00–21:00` 内工作，绝不会由 `run` 或 `daily` 间接触发。它启动时检测主机 IANA 时区和 UTC 偏移，再换算到 `Asia/Shanghai`；每场按低等级 Boss 优先，最多并发处理 3 个账号，每个账号只提交 1 次协助以获取首领门票。提交标记会在请求前持久化，避免响应不明确或进程重启后重复挑战。只有服务端明确返回 `rewardStatus: "claimable"` 时才领奖。

每日活跃默认尝试领取 `20/40/60/80/100` 档。运行器每次都会先穿戴各部位评分最高的装备，再分批分解背包中的普通、优秀、精良、稀有和史诗装备；即使已经领取 100 档也会完成清理。默认不保护高级或未知词条，但只处理未锁定、等级不高于 999、评分有效且低于 99999 的背包装备；评分为空、纯空格或缺失时跳过。清理完成后若仍未达到 100，每个账号每天最多购买一件实际成交额最低且不超过 300 金币的市场商品。运行器不会自动强化、上架、捐献或消费元宝。

可在 `automation.daily` 中调整安全范围：

```json
{
  "activityRewardPoints": [20, 40, 60, 80, 100],
  "marketMaxGold": 300,
  "decomposition": {
    "qualities": ["common", "excellent", "refined", "rare", "epic"],
    "maxLevel": 999,
    "maxScore": 99999,
    "protectPremiumAffixes": false
  }
}
```

`qualities` 支持 `common`、`excellent`、`refined`、`rare`、`epic`、`legendary` 和 `mythic`。`maxLevel` 为包含边界，`maxScore` 为不包含边界；评分必须是非空有效数字。显式设置 `protectPremiumAffixes: true` 可保留高级和未知词条装备。先使用 `run --dry-run` 检查计划动作；模拟运行只读取状态和首领预览，不挑战、分解或购买。

运行时 Session 和操作日志存储在 `.placegame-state.local.json` 中；脱敏后的 JSONL 报告写入 `.placegame-logs/`。这两个路径均已被 Git 忽略。
每日 JSONL 报告默认保留 30 天；可通过账号配置中的 `automation.logRetentionDays` 调整保留时间。

### 定时运行

macOS：

```sh
sh scripts/install-macos-launchd.sh
```

Linux 用户级服务：

```sh
sh scripts/install-linux-systemd.sh
```

安装脚本会创建两个彼此独立的任务：日常任务每 15 分钟运行一次；世界 Boss 常驻调度器在启动时记录本地时区，如果当前正处于活动窗口则恢复一次未完成场次，之后按北京时间每天 `10:00`、`16:00`、`20:00` 准点各触发一次。日常业务仍会为每个账号加入稳定的随机偏移，大约每六小时收取一次，并在接近 12 小时上限时优先收取。使用同一个脚本并加上 `--uninstall` 即可卸载两项任务。

### 验证

```sh
npm test
npm run check
```

## English

This is a local Node.js runner for multi-account PlaceGame automation on macOS and Linux.

### Platform support

The runner requires Node.js 24 or newer. After cloning the repository, check account status or perform a dry run with:

```sh
node placegame-auto.mjs status
node placegame-auto.mjs run --dry-run
```

The runner maintains its own private local Session file, so it does not need to log in on every execution.

### Configure accounts

Use the existing `.placegame-accounts.local.json` or start from `placegame-accounts.example.json`. Multiple entries in `accounts` are processed independently.
Account aliases appear in reports, so use non-identifying local labels such as `account-1`; do not use a username, character nickname, or player ID.

```sh
chmod 600 .placegame-accounts.local.json
```

The runner refuses symlinks, non-regular files, files owned by another user, and any credential-file mode other than `0600`.

### Run

```sh
node placegame-auto.mjs status
node placegame-auto.mjs run --dry-run
node placegame-auto.mjs idle
node placegame-auto.mjs daily
node placegame-auto.mjs arcade
node placegame-auto.mjs boss
node placegame-auto.mjs world-boss --dry-run
node placegame-auto.mjs run
```

Use `--account account-1` to select one alias and `--json` for structured output. `run` executes idle/map maintenance, free arcade, personal bosses, and daily rewards. Personal-boss automation uses only the shared five free wins, requires at least a 10% predicted win chance, never spends tickets, and enables the material boost for higher-quality equipment. After every win it equips stronger gear before selecting the next weakest slot, and submits at most 20 challenges per run. Daily rewards include sign-in, main and side quests, achievements, codex, season, reward mail, activity chests, and earned guild progress; the runner never donates automatically.

`world-boss` is independent and only runs inside the `10:00–11:00`, `16:00–17:00`, and `20:00–21:00` Beijing windows; neither `run` nor `daily` invokes it. It detects the host IANA timezone and UTC offset before converting to `Asia/Shanghai`, prioritizes lower-level bosses, and processes at most three accounts concurrently. Each account submits exactly one assist per event to obtain a boss ticket. The submission marker is persisted before the request so an ambiguous response or process restart cannot cause a duplicate challenge. Rewards are claimed only for the explicit server state `rewardStatus: "claimable"`.

The activity ladder claims the known `20/40/60/80/100` tiers. On every run, it first equips the highest-scoring item in each slot, then decomposes common, excellent, refined, rare, and epic bag items in bounded batches, even when the 100-point chest is already claimed. Premium and unknown affix ranks are not protected by default, but only unlocked bag items at level 999 or lower with a valid score below 99999 are eligible; empty, whitespace-only, or missing scores are skipped. If 100 is still incomplete after cleanup, the final fallback buys at most one lowest-charge market unit per account per day, capped at 300 gold. It never enhances, lists, donates, or spends rare currency.

Configure the safety boundary under `automation.daily`:

```json
{
  "activityRewardPoints": [20, 40, 60, 80, 100],
  "marketMaxGold": 300,
  "decomposition": {
    "qualities": ["common", "excellent", "refined", "rare", "epic"],
    "maxLevel": 999,
    "maxScore": 99999,
    "protectPremiumAffixes": false
  }
}
```

Supported quality names are `common`, `excellent`, `refined`, `rare`, `epic`, `legendary`, and `mythic`. `maxLevel` is inclusive and `maxScore` is exclusive; the score must be a non-empty finite number. Set `protectPremiumAffixes: true` explicitly to retain premium and unknown affix ranks. Run `run --dry-run` first to inspect planned actions; dry-run performs reads and boss previews but never challenges, decomposes, or buys.

Runtime Sessions and action journals are stored in `.placegame-state.local.json`. Redacted JSONL reports go to `.placegame-logs/`. Both paths are ignored by Git.
Daily JSONL reports are retained for 30 days by default; change `automation.logRetentionDays` in the account config to adjust this.

### Schedule

macOS:

```sh
sh scripts/install-macos-launchd.sh
```

Linux user service:

```sh
sh scripts/install-linux-systemd.sh
```

The installer creates two independent jobs. Daily automation runs every 15 minutes. The persistent world-boss scheduler logs the detected host timezone at startup, recovers one incomplete event when startup occurs inside an activity window, then triggers once at exactly `10:00`, `16:00`, and `20:00` Beijing time. Daily collection still uses stable per-account jitter around six hours and prioritizes collection near the 12-hour cap. Uninstall both jobs with the same script plus `--uninstall`.

### Verify

```sh
npm test
npm run check
```
