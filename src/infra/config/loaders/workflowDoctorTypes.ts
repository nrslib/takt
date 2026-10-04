export type WorkflowDiagnostic = {
  level: 'error' | 'warning';
  message: string;
  path?: readonly PropertyKey[];
};

export type WorkflowDoctorReport = {
  diagnostics: WorkflowDiagnostic[];
  filePath: string;
};
