# Karpo Interview Assistant · Chrome Extension

实时 AI 协访谈助手 — Google Meet 旁边的 sidebar，提供实时翻译、智能追问、完整性检查、用户画像提取。

## 📦 文件结构

```
extension/
├── manifest.json       # MV3 manifest
├── background.js       # Service worker (WS lifecycle, message routing)
├── content.js          # 注入到 meet.google.com 的轻量脚本
├── sidepanel.html      # 主 UI
├── sidepanel.css       # 样式（暗色主题 + 紫色品牌色）
├── sidepanel.js        # UI 逻辑 + 后端通讯 + 实时渲染
├── icons/              # 16/48/128 PNG 图标
└── README.md
```

## 🚀 安装步骤

### 1. 准备后端
确保 backend 已启动并填了 `ANTHROPIC_API_KEY`：
```bash
cd ../backend
cp .env.example .env
# 编辑 .env，填入 sk-ant-xxx
python main.py
# 验证：curl http://localhost:8000/api/health
```

### 2. 安装扩展（开发模式）
1. 打开 Chrome → `chrome://extensions`
2. 右上角打开 **Developer mode**
3. 点 **Load unpacked** → 选择本目录（`extension/`）
4. 看到 Karpo 图标出现在工具栏即安装成功

### 3. 使用
1. 打开任意 Google Meet（或先开个 tab 测试）
2. 点击 Karpo 扩展图标 → 右侧 Side Panel 打开
3. **首次使用**：
   - 输入 Backend URL（默认 `http://localhost:8000`）
   - 点 **Check connection** 确认后端 OK
   - 填入受访者姓名、你的姓名、是否 Karpo 老用户
   - 点 **Start Session**
4. 访谈进行中：
   - 在底部输入框粘贴受访者刚说的话 → 点 **Submit turn**
   - 几秒内右侧出现翻译、追问、覆盖度、画像更新
   - 点击任意追问 → 自动复制到剪贴板
5. 访谈结束：
   - 点 **End session** → 自动生成人物小传报告
   - 点 **Copy report** 复制到剪贴板，粘贴到 Notion/Lark

## 🎯 4 个核心 Tab

| Tab | 功能 |
|---|---|
| **Live** | 节奏告警 + 实时追问建议 + 最近 2 轮对话 |
| **Coverage** | 6 模块完整性看板，每个模块可折叠，⭐ 标记高价值点 |
| **Profile** | 自动提取的画像 + 🔥 关键洞察 + 💬 高价值原话 |
| **Transcript** | 全文记录（英文 + 中文翻译） |

## 🔧 配置

后端 URL 在 Setup 视图中可改，默认 `http://localhost:8000`。如果用 e2b 沙盒后端：
```
https://8000-iki7jucatxb9vpgay5r2t.e2b.dev
```

## 🐛 常见问题

**Q: Side panel 打不开**
- 确认 Chrome 版本 ≥ 114
- 试试右键扩展图标 → "Open side panel"

**Q: "Cannot reach backend"**
- 后端没启动？运行 `python backend/main.py`
- URL 错？必须包含协议（http://）和端口（:8000）
- CORS 问题？后端已配置 `allow_origins=["*"]`，应该不会遇到

**Q: 追问没有出现**
- 看后端日志：`[LLM] task=followup ...` 是否报错
- 最常见原因：`ANTHROPIC_API_KEY` 没配或额度耗尽
- 后端 `/api/health` 看是否 degraded

**Q: 翻译是空的**
- 翻译用的是 `claude-haiku-4-5`，比追问任务快但偶尔会被 rate limit
- 看后端日志的 `task=translate` 行

## 🔮 下一步（C-2 之后）

目前 C-2 完成的是 **手动输入模式** —— 你需要把受访者说的话粘贴到底部输入框。

后续可以加：
- **C-2.1 音频自动捕获**：通过 Chrome `chrome.tabCapture` + offscreen document 抓取 Meet tab 的音频，流式传给后端 Deepgram，自动生成 transcript
- **C-2.2 说话人分离**：根据 Meet DOM 检测当前说话者，自动判断是 interviewer 还是 interviewee
- **C-2.3 自定义提纲**：UI 里允许选择不同的访谈提纲（不同产品/不同人群）
