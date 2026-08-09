// Trie 数据结构用于快速前缀匹配和查询补全

class TrieNode {
  children: Map<string, TrieNode> = new Map();
  isEnd = false;
  value?: string; // 完整的词条
  category?: string; // 词条分类
  translation?: string; // 英文翻译
}

export class Trie {
  private readonly root = new TrieNode();

  // 插入一个词条
  insert(word: string, category?: string, translation?: string): void {
    let node = this.root;
    for (const char of word) {
      let child = node.children.get(char);
      if (!child) {
        child = new TrieNode();
        node.children.set(char, child);
      }
      node = child;
    }
    node.isEnd = true;
    node.value = word;
    node.category = category;
    node.translation = translation;
  }

  // 搜索前缀匹配的所有词条
  search(
    prefix: string,
    limit = 10
  ): Array<{
    word: string;
    category?: string;
    translation?: string;
  }> {
    let node = this.root;

    // 找到前缀节点
    for (const char of prefix) {
      const child = node.children.get(char);
      if (!child) {
        return [];
      }
      node = child;
    }

    // 从前缀节点开始 DFS 收集所有词条
    const results: Array<{
      word: string;
      category?: string;
      translation?: string;
    }> = [];

    const dfs = (current: TrieNode) => {
      if (results.length >= limit) {
        return;
      }

      if (current.isEnd && current.value) {
        results.push({
          word: current.value,
          category: current.category,
          translation: current.translation,
        });
      }

      // 按字典序遍历子节点
      const sortedKeys = Array.from(current.children.keys()).sort();
      for (const key of sortedKeys) {
        if (results.length >= limit) {
          break;
        }
        const child = current.children.get(key);
        if (child) {
          dfs(child);
        }
      }
    };

    dfs(node);
    return results;
  }

  // 检查是否存在某个词
  has(word: string): boolean {
    let node = this.root;
    for (const char of word) {
      const child = node.children.get(char);
      if (!child) {
        return false;
      }
      node = child;
    }
    return node.isEnd;
  }
}
