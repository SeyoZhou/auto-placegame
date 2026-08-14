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
node placegame-auto.mjs run
```

使用 `--account account-1` 选择指定别名的账号，使用 `--json` 获取结构化输出。`run` 会依次执行挂机/地图维护、免费街机、个人首领和每日奖励。个人首领只使用共享的 5 次免费胜场，预测胜率不低于 80%，不使用门票，单轮最多提交 20 次挑战。每日奖励会领取签到、主线/支线、成就、图鉴、赛季、邮件、活跃宝箱和已达成的公会进度奖励，但不会自动捐献。

每日活跃默认尝试领取 `20/40/60/80/100` 档。运行器每次都会先穿戴各部位评分最高的装备，再分批安全分解背包中所有普通、优秀和精良装备；即使已经领取 100 档也会完成清理。默认保留所有 `小极品/极品/大极品` 和未知词条等级装备。清理完成后若仍未达到 100，每个账号每天最多购买一件实际成交额最低且不超过 300 金币的市场商品。运行器不会自动强化、上架、捐献或消费元宝。

可在 `automation.daily` 中调整安全范围：

```json
{
  "activityRewardPoints": [20, 40, 60, 80, 100],
  "marketMaxGold": 300,
  "decomposition": {
    "qualities": ["common", "excellent", "refined"],
    "minLevel": 1,
    "maxLevel": 20,
    "protectPremiumAffixes": true
  }
}
```

`qualities` 支持 `common`、`excellent`、`refined`、`rare`、`epic`、`legendary` 和 `mythic`。省略 `minLevel` 或 `maxLevel` 表示该方向不设限制。先使用 `run --dry-run` 检查计划动作；模拟运行只读取状态和首领预览，不挑战、分解或购买。

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

两个调度器都会每 15 分钟运行一次，并在启动或登录时运行一次。业务逻辑会为每个账号加入稳定的随机偏移，大约每六小时收取一次，并在接近 12 小时上限时优先收取。使用同一个脚本并加上 `--uninstall` 即可卸载。

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
node placegame-auto.mjs run
```

Use `--account account-1` to select one alias and `--json` for structured output. `run` executes idle/map maintenance, free arcade, personal bosses, and daily rewards. Personal-boss automation uses only the shared five free wins, requires at least an 80% predicted win chance, never spends tickets, and submits at most 20 challenges per run. Daily rewards include sign-in, main and side quests, achievements, codex, season, reward mail, activity chests, and earned guild progress; the runner never donates automatically.

The activity ladder claims the known `20/40/60/80/100` tiers. On every run, it first equips the highest-scoring item in each slot, then safely decomposes every common, excellent, and refined bag item in bounded batches, even when the 100-point chest is already claimed. Premium and unknown affix ranks are protected by default. If 100 is still incomplete after cleanup, the final fallback buys at most one lowest-charge market unit per account per day, capped at 300 gold. It never enhances, lists, donates, or spends rare currency.

Configure the safety boundary under `automation.daily`:

```json
{
  "activityRewardPoints": [20, 40, 60, 80, 100],
  "marketMaxGold": 300,
  "decomposition": {
    "qualities": ["common", "excellent", "refined"],
    "minLevel": 1,
    "maxLevel": 20,
    "protectPremiumAffixes": true
  }
}
```

Supported quality names are `common`, `excellent`, `refined`, `rare`, `epic`, `legendary`, and `mythic`. Omit either level boundary to leave it open. Run `run --dry-run` first to inspect planned actions; dry-run performs reads and boss previews but never challenges, decomposes, or buys.

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

Both schedulers run every 15 minutes and once at startup/login. Business logic collects each account at roughly six hours with stable per-account jitter and prioritizes collection near the 12-hour cap. Uninstall with the same script plus `--uninstall`.

### Verify

```sh
npm test
npm run check
```
