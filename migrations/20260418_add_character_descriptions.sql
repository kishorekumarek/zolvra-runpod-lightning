-- Add character_descriptions JSONB column to pipeline_state
-- Stores Gemini's character descriptions from Stage 2 for Stage 3 to use
ALTER TABLE pipeline_state
ADD COLUMN IF NOT EXISTS character_descriptions JSONB DEFAULT NULL;
