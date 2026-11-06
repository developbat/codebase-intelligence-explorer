import type { FileRecord } from "../../../shared/types";

export interface TreeNode {
  name: string;
  path: string;
  type: "folder" | "file";
  children: TreeNode[];
  file?: FileRecord;
}

interface MutableFolder {
  name: string;
  path: string;
  type: "folder";
  children: Map<string, MutableFolder | MutableFile>;
}

interface MutableFile {
  name: string;
  path: string;
  type: "file";
  file: FileRecord;
}

export function buildTree(files: FileRecord[]): TreeNode[] {
  const root: MutableFolder = { name: "", path: "", type: "folder", children: new Map() };

  for (const file of files) {
    const segments = file.path.split("/");
    let current = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      const path = segments.slice(0, index + 1).join("/");
      let next = current.children.get(segment);
      if (!next || next.type !== "folder") {
        next = { name: segment, path, type: "folder", children: new Map() };
        current.children.set(segment, next);
      }
      current = next as MutableFolder;
    }
    const fileName = segments[segments.length - 1];
    current.children.set(fileName, {
      name: fileName,
      path: file.path,
      type: "file",
      file,
    });
  }

  function toNodes(folder: MutableFolder): TreeNode[] {
    const nodes: TreeNode[] = [];
    for (const child of folder.children.values()) {
      if (child.type === "folder") {
        nodes.push({ name: child.name, path: child.path, type: "folder", children: toNodes(child) });
      } else {
        nodes.push({ name: child.name, path: child.path, type: "file", children: [], file: child.file });
      }
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  return toNodes(root);
}

export function collectFolderPaths(nodes: TreeNode[], depth = 2, acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === "folder" && depth > 0) {
      acc.push(node.path);
      collectFolderPaths(node.children, depth - 1, acc);
    }
  }
  return acc;
}
