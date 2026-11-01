import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopLocalService } from './lib/service.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
try {
  const stopped = await stopLocalService(root);
  console.log(stopped ? '工作台已关闭，数据已保存。' : '当前项目的工作台未在运行。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
