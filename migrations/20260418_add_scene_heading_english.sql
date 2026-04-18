-- Add heading and english columns to scenes table
-- heading: brief scene title from Gemini
-- english: English translation of the Tamil TANGLISH dialogue
ALTER TABLE scenes
ADD COLUMN IF NOT EXISTS heading TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS english TEXT DEFAULT NULL;
