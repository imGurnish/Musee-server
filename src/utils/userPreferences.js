const { supabase, supabaseAdmin } = require('../db/config');

function normalizeLanguageCode(value) {
    if (typeof value !== 'string') return null;
    const code = value.trim().toLowerCase();
    return code || null;
}

function normalizeLanguageCodes(value) {
    const values = Array.isArray(value) ? value : (value ? [value] : []);
    const codes = values
        .map(normalizeLanguageCode)
        .filter(Boolean);
    return Array.from(new Set(codes));
}

async function getUserOnboardingPreferences(userId) {
    if (!userId) return null;

    const client = supabaseAdmin || supabase;
    const { data, error } = await client
        .from('user_onboarding_preferences')
        .select('preferred_languages, preferred_region_id, favorite_genres, favorite_moods, favorite_artists, allow_recommendations, include_random_songs, randomness_percentage, allow_new_releases, allow_trending_tracks, completed_at')
        .eq('user_id', userId)
        .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const preferredLanguages = normalizeLanguageCodes(data.preferred_languages);

    return {
        ...data,
        preferred_languages: preferredLanguages,
        preferred_language: preferredLanguages[0] || null,
    };
}

module.exports = {
    getUserOnboardingPreferences,
    normalizeLanguageCode,
    normalizeLanguageCodes,
};