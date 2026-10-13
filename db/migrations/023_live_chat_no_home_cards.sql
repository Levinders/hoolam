-- The chat's Home tab now shows only "Prefer WhatsApp?", so the Home cards are gone for good.
DELETE FROM chat_content WHERE kind = 'HOME';
