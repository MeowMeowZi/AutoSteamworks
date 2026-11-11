#!/usr/bin/env node
// 命令行入口：用 tsx 直接加载 TypeScript 源码，不需要构建步骤（全局安装、omit=dev 时也能用）
import { register } from 'tsx/esm/api';

register();
await import('../src/cli.ts');
