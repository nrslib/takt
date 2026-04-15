export type WorkflowDiagnostic = {
  level: 'error' | 'warning';
  message: string;
};

export type WorkflowDoctorReport = {
  diagnostics: WorkflowDiagnostic[];
  filePath: string;
};
