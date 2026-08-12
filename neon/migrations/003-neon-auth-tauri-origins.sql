BEGIN;

UPDATE neon_auth.project_config
SET trusted_origins = (
  SELECT jsonb_agg(origin ORDER BY origin)
  FROM (
    SELECT DISTINCT value AS origin
    FROM jsonb_array_elements_text(COALESCE(trusted_origins, '[]'::jsonb))
    UNION
    SELECT unnest(ARRAY[
      'http://tauri.localhost',
      'https://tauri.localhost',
      'http://localhost:1430',
      'http://127.0.0.1:1430'
    ])
  ) AS allowed
);

COMMIT;
