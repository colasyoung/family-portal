本目录：family-portal 在 GitHub Pages 上唯一需要长期维护的成绩数据位置。

【命名（与课堂成绩系统「导出数据备份」一致）】
  stack_class_backup_YYYY-MM-DD.json
  同一天多次导出：stack_class_backup_YYYY-MM-DD_2.json、_3 …

【维护方式】
  1. 将导出的 .json 复制到本目录（可保留多份历史）。
  2. 在项目根目录执行：
       node tools/update-data-manifest.mjs
     会扫描本目录下符合命名的文件，重写 manifest.json 的 files 列表。
  3. 网页加载时会从 manifest 中挑选「最新」的一份（按日期与同日序号）。

【可选】固定别名：将当前要上线的文件复制为 data/stack_class_backup.json（无日期），
  在 manifest 缺失或列表为空时仍会尝试加载（便于临时替换）。

【班级专用链接口令（可选）】
  在成绩 JSON 根级可增加字段 portalClassTokens（对象），键为 classId，值为仅含字母数字与连字符的口令字符串，例如：
    "portalClassTokens": {
      "class_1774857444387": "donggaodi-mon-2026-a7c3"
    }
  家长打开：index.html?token=donggaodi-mon-2026-a7c3
  则直接进入该班排行榜，无需选择班级、也无需输入学生姓名。榜单页「复制分享链接」会生成同一类地址。
  口令需唯一、勿过短；公开仓库等于公开口令，任何人持链接即可看该班榜，请自行评估隐私与合规。

【勿提交】若使用私有数据，请根据仓库策略自行决定是否忽略部分文件；公开仓库勿提交真实姓名成绩到公开分支。
