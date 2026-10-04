export interface DirectoryEntry {
  name: string;
  kind: 'directory' | 'file' | 'link' | 'other';
}
export interface DirectoryPage {
  entries: DirectoryEntry[];
  total: number;
  offset: number;
  nextCursor: string | null;
  truncated: boolean;
}
