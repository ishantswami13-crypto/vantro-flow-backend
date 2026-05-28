# File & Upload Security
- Size limits: Enforced (multer)
- MIME/Extension allowlist: Enforced
- Path traversal/Executable rejection: Active
- XLSX Parsing: High Risk. Restrict upload types, limit rows/cols, never parse unauthenticated.
