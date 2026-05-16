# 应收账款逾期提醒 Demo

本 Demo 用于演示（按需求点）：
- 录入客户/项目/应收金额/已收金额/到期日/负责人
- 自动计算未收金额、状态（未到期/即将到期/今日到期/已逾期/已结清）
- 自动计算逾期天数、展示逾期列表
- 生成提醒内容（将到期/逾期）
- 避免重复提醒（去重）
- 记录提醒日志
- 备份与恢复数据
- OCR：支持上传任意图片“尽力识别”，输出结构化草稿，并强制人工确认后入库

## 运行

> Windows PowerShell 可能会拦截 `npm.ps1/npx.ps1`，请优先使用 `npm.cmd/npx.cmd`。

1) 安装依赖

- `D:\nodejs\npm.cmd install`

2) 启动开发服务器

- `D:\nodejs\npm.cmd run dev`

浏览器打开终端提示的本地地址即可。

## 演示流程（建议 2–3 分钟）

1. 进入“台账”页：新增 2–3 条账款（包含一个已逾期、一个将到期）。
2. 进入“OCR导入”页：上传一张表格截图/图片做一次 OCR，得到草稿 → 手工确认 → 入库。
3. 进入“提醒&日志”页：点击“生成提醒（今天）”→ 对其中 1 条点击“模拟发送”。
4. 再次点击同一条“模拟发送”：观察日志出现 `skipped-duplicate`，证明去重生效。
5. 进入“备份恢复”页：导出备份（JSON）→ 清空数据 → 导入恢复。

## 线上试用（GitHub Pages）

部署成功后，客户可直接打开（无需登录）：

- https://yfyu0819-hub.github.io/ar-overdue-reminder-demo/

启用方式（仓库管理员操作一次即可）：

1. 进入 GitHub 仓库 → Settings → Pages
2. Build and deployment 选择 “GitHub Actions”
3. 等待 Actions 里 “Deploy to GitHub Pages” 工作流跑完

## 说明（后续对接飞书/企微）

- 建议新增“通知适配器”模块：把提醒内容 `message` 通过 Webhook POST 到飞书/企微机器人。
- 生产建议：失败重试、限流、签名校验、幂等键（本 Demo 的 `invoiceId|type|windowKey`）以及告警。

## 文件结构

- `src/main.js`：单页 UI 与交互
- `src/domain.js`：自动计算、提醒生成、去重 Key、消息模板
- `src/ocr.js`：OCR 识别与文本解析（规则优先，无法确定则低置信度）
- `src/store.js`：本地存储（localStorage）+ 备份/恢复
- `public/samples/*`：内置演示图片
