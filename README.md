# StockHunter

A股优选股票筛选工具，部署在 Cloudflare Workers 上。

## 功能

- 每日收盘后自动筛选涨停股票（涨幅≥9.5%）
- 筛选条件：市值≥50亿、市盈率0-40、换手率≥3%、市净率≤3
- 结果通过 Telegram 推送 + 前端页面展示

## 部署

```bash
npm install
npx wrangler deploy
```

## 使用

| 地址 | 说明 |
|---|---|
| `/` | 前端页面 |
| `/trigger` | 手动触发筛选 |

## 技术栈

- TypeScript + Cloudflare Workers
- Cloudflare KV（历史记录存储）
- Sina Finance API（股票数据）
- Chart.js（数据可视化）
- GitHub Actions（CI/CD 自动部署）
