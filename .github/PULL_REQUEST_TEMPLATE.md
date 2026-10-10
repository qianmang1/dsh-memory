<!--
提交前自查：
- 写入路径的改动跑过 npm test（node --import tsx --test）
- 不引入凭据明文；配置示例里凭据一律留空字符串
- 涉及待审队列时，pendingDir 语义与 capture/review/core/debug 四处保持一致
-->
## 改了什么

<!-- 一两句说清动机与方案 -->

## 自查

- [ ] `npm test` 全过
- [ ] 无凭据明文
- [ ] 涉及队列的改动已核对 pendingDir 约定
