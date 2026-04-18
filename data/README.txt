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
  4. 运行 update-data-manifest.mjs 时会保留 manifest 中已有的 visibleClassIds、hiddenClassIds（见下）。

【门户：限制首页「按姓名查找」所考虑的班级（manifest.json，可选）】
  在 manifest.json 中与 files 同级可手动配置（键名如下；勿放进备份 JSON 内）：
  - visibleClassIds：字符串数组；非空时，仅在这些 classId 中匹配学生姓名（须与备份里 classes[].id 一致）。
  - hiddenClassIds：字符串数组；从上述匹配范围内排除这些 classId。
  二者可同时使用：先按白名单再排除黑名单。未配置则在备份中的全部班级里查找姓名（仍受 cup-core 归档排序影响）。
  姓名匹配：须输入与登记一致的完整姓名（去空白后汉字全等，或无声调全拼与多音字组合之一全等；登记英文名按连续字母全等）。不支持仅姓、仅名或拼音片段。英文习惯「名 姓」时，带空格、无空格连续（如 anyuewang）或与姓在前整串（如 wanganyue）均会尝试对应。多音字按 polyphonic 组合并与整句默认读音一并匹配。见 vendor/pinyin-pro.mjs、pinyin-name.js。
  首页入口为：输入学生完整姓名（汉字或全拼）→ 列出其在门户可见班级中的匹配 → 点选后将跳转到带 ?classId=、entry=lookup、studentId=（及可选 ?token=）的地址再进入该班成绩页；成绩表会高亮并滚动到该生一行（entry/studentId 仅用于姓名查找流程；复制分享链接不含此二参数）。便于浏览器后退回到无参数的总入口。
  说明：?classId= 分享链接与 ?token= 口令入口若指向某班，仍以备份数据为准，不经过上述门户列表校验。
  无查询参数打开总入口时会清空 sessionStorage 中的班级会话，避免从上述链接页后退时仍自动进入主页。

【可选】固定别名：将当前要上线的文件复制为 data/stack_class_backup.json（无日期），
  在 manifest 缺失或列表为空时仍会尝试加载（便于临时替换）。

【班级专用链接口令（可选）】
  在成绩 JSON 根级可增加字段 portalClassTokens（对象），键为 classId，值为仅含字母数字与连字符的口令字符串，例如：
    "portalClassTokens": {
      "class_1774857444387": "donggaodi-mon-2026-a7c3"
    }
  家长打开：index.html?token=donggaodi-mon-2026-a7c3
  则直接进入该班成绩页，无需经总入口按姓名查找班级。在成绩页「复制分享链接」会生成同一类地址。
  口令需唯一、勿过短；公开仓库等于公开口令，任何人持链接即可查看该班成绩，请自行评估隐私与合规。

【勿提交】若使用私有数据，请根据仓库策略自行决定是否忽略部分文件；公开仓库勿提交真实姓名成绩到公开分支。
