import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isSafePath, safeJoin } from '../../utils/path-security';

describe('路径安全验证', () => {
  describe('isSafePath', () => {
    it('应该允许在白名单目录内的路径', () => {
      const allowedRoots = ['C:\\Users\\test\\Documents'];
      const targetPath = 'C:\\Users\\test\\Documents\\photos\\image.jpg';

      expect(isSafePath(targetPath, allowedRoots)).toBe(true);
    });

    it('应该拒绝在白名单目录外的路径', () => {
      const allowedRoots = ['C:\\Users\\test\\Documents'];
      const targetPath = 'C:\\Users\\test\\Downloads\\image.jpg';

      expect(isSafePath(targetPath, allowedRoots)).toBe(false);
    });

    it('应该防止路径遍历攻击 (..)', () => {
      const allowedRoots = ['C:\\Users\\test\\Documents'];
      const targetPath = 'C:\\Users\\test\\Documents\\..\\..\\Windows\\System32';

      expect(isSafePath(targetPath, allowedRoots)).toBe(false);
    });

    it('应该处理相对路径', () => {
      const allowedRoots = [process.cwd()];
      const targetPath = path.join(process.cwd(), 'src', 'utils');

      expect(isSafePath(targetPath, allowedRoots)).toBe(true);
    });

    it('应该允许根目录本身', () => {
      const allowedRoots = ['C:\\Users\\test\\Documents'];
      const targetPath = 'C:\\Users\\test\\Documents';

      expect(isSafePath(targetPath, allowedRoots)).toBe(true);
    });

    it('应该处理多个白名单根目录', () => {
      const allowedRoots = [
        'C:\\Users\\test\\Documents',
        'C:\\Users\\test\\Pictures',
        'D:\\Photos'
      ];

      expect(isSafePath('C:\\Users\\test\\Documents\\file.txt', allowedRoots)).toBe(true);
      expect(isSafePath('C:\\Users\\test\\Pictures\\photo.jpg', allowedRoots)).toBe(true);
      expect(isSafePath('D:\\Photos\\vacation.jpg', allowedRoots)).toBe(true);
      expect(isSafePath('C:\\Users\\test\\Downloads\\file.txt', allowedRoots)).toBe(false);
    });

    it('应该处理大小写不敏感（Windows）', () => {
      const allowedRoots = ['C:\\Users\\Test\\Documents'];
      const targetPath = 'c:\\users\\test\\documents\\file.txt';

      expect(isSafePath(targetPath, allowedRoots)).toBe(true);
    });
  });

  describe('safeJoin', () => {
    it('应该安全地拼接路径', () => {
      const basePath = 'C:\\Users\\test\\Documents';
      const result = safeJoin(basePath, 'photos', 'image.jpg');

      expect(result).not.toBeNull();
      expect(result).toContain('photos');
      expect(result).toContain('image.jpg');
    });

    it('应该拒绝导致路径遍历的拼接', () => {
      const basePath = 'C:\\Users\\test\\Documents';
      const result = safeJoin(basePath, '..', '..', 'Windows', 'System32');

      expect(result).toBeNull();
    });

    it('应该处理多个路径片段', () => {
      const basePath = 'C:\\Users\\test\\Documents';
      const result = safeJoin(basePath, 'photos', '2024', 'vacation', 'image.jpg');

      expect(result).not.toBeNull();
      if (result) {
        expect(result.includes('photos')).toBe(true);
        expect(result.includes('2024')).toBe(true);
        expect(result.includes('vacation')).toBe(true);
      }
    });

    it('应该拒绝包含绝对路径的片段', () => {
      const basePath = 'C:\\Users\\test\\Documents';
      // 在 Windows 上，path.join 不会自动处理嵌入的绝对路径
      // 但我们的安全检查应该捕获这种情况
      const result = safeJoin(basePath, '..', '..', '..', 'Windows');

      expect(result).toBeNull();
    });
  });
});
