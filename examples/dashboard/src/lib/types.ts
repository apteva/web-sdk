export interface Lead {
  id: number;
  name: string;
  email: string;
  phone: string;
  source: string;
  status: "new" | "contacted" | "qualified" | "won" | "lost";
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface TablesListResult {
  tables: TableSummary[];
}

export interface TableSummary {
  id: number;
  name: string;
  scope: string;
  columns: TableColumn[];
  row_count: number;
  created_at: string;
}

export interface TableColumn {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface RowsSearchResult {
  rows: Array<Record<string, unknown>>;
  total: number;
}
