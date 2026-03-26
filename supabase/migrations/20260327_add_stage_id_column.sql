ALTER TABLE video_pipeline_runs ADD COLUMN IF NOT EXISTS stage_id text;

UPDATE video_pipeline_runs SET stage_id = CASE stage
  WHEN 2 THEN 'script'
  WHEN 3 THEN 'characters'
  WHEN 4 THEN 'illustrate'
  WHEN 5 THEN 'animate'
  WHEN 6 THEN 'tts'
  WHEN 7 THEN 'assemble'
  WHEN 8 THEN 'queue'
  WHEN 9 THEN 'publish'
  ELSE NULL
END
WHERE stage_id IS NULL;
