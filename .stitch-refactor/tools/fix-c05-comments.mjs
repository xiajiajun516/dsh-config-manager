
import fs from 'node:fs';
const fixes = {
  'D-09': [['危险按钮在左、取消在右', '取消在左、危险按钮在最右（DESIGN.md §7-30）']],
  'D-10': [['(确认导入 + 取消，属于内容区末尾)', '(取消 + 确认导入，确认在最右；DESIGN.md §7-30)']],
  'D-15': [['按钮右对齐：左深色危险确认、右描边取消', '按钮右对齐：左描边取消、最右深色危险确认'],
           ['左边深色危险按钮「重新克隆」', '最右深色危险按钮「重新克隆」']],
  'D-17': [['左边深色主按钮「复制」', '最右深色主按钮「复制」']],
  'D-18': [['左红底「停止」、右 ghost「取消」', '左 ghost「取消」、最右红底「停止」']],
  'D-20': [['「执行恢复」在左、「取消」在右', '「取消」在左、「执行恢复」在最右']],
  'D-26': [['左边「清理」危险主按钮，右边「取消」ghost', '左边「取消」ghost，最右「清理」危险主按钮'],
           ['左边：确认在左（危险主按钮「清理」', '最右：危险主按钮「清理」']],
  'D-35': [['「确认回滚」在左、「取消」在右', '「取消」在左、「确认回滚」在最右']],
};
for (const [id, pairs] of Object.entries(fixes)) {
  const p = '.stitch-refactor/out/' + id + '.html';
  let s = fs.readFileSync(p, 'utf8');
  let n = 0;
  for (const [a, b] of pairs) { if (s.includes(a)) { s = s.replace(a, b); n++; } else console.log(id + ' MISS: ' + a); }
  fs.writeFileSync(p, s, 'utf8');
  console.log(id + ' comment-fixes=' + n);
}
