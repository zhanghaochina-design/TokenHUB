# HTML README 源文件

根目录的 `README.html` 是发布产物，由本目录生成。修改内容请改这里，不要直接编辑根目录 HTML。

- `template.html`：正文与样式；图片位置使用 `{{IMG_*}}` 占位符。
- `assets/`：界面截图，来自真实 Electron 界面的演示数据；使用演示端口 18799，所有 Key 均为假值。
- `build.mjs`：把 `assets/` 中的截图内联为 base64，生成根目录 `README.html`。
- `capture.mjs`：启动演示实例、写入演示数据并重拍截图到 `assets/`。

## 生成文档

```bash
node docs/readme/build.mjs
```

## 重拍截图

先构建 Electron，再运行截图脚本：

```bash
npm run build
node docs/readme/capture.mjs
```

截图脚本使用临时数据目录 `out/readme-demo-data` 与演示端口 18799，结束后删除临时数据；Key 通过应用自身的加密接口写入，不落明文。新增或删除截图时，同时更新 `template.html` 的 `{{IMG_*}}` 占位符与 `build.mjs` 的映射。
