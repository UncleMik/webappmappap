-- Expand the existing allowlist without replacing any saved reactions.
ALTER TABLE club_message_reactions DROP CONSTRAINT IF EXISTS club_message_reactions_reaction_check;
ALTER TABLE club_message_reactions ADD CONSTRAINT club_message_reactions_reaction_check
  CHECK (reaction IN ('heart', 'love', 'like', 'hug', 'laugh'));
