//enums

const subscriptionTypes = new Set(['free', 'premium', 'trial']);
const userTypes = new Set(['listener', 'artist', 'admin']);
const genders = new Set(['Male', 'Female', 'Other', 'Prefer not to say']);
const billingCycles = new Set(['monthly', 'yearly', 'lifetime']);
const artistRoles = new Set(['owner', 'editor', 'viewer']);
const audioExts = new Set(['mp3', 'ogg']);
const languages = new Set(["English", "Hindi","Punjabi", "Bengali", "Tamil", "Telugu", "Marathi", "Gujarati", "Urdu", "Malayalam", "Kannada", "Oriya", "Assamese", "Maithili", "Bhojpuri", "Rajasthani", "Haryanvi", "Chhattisgarhi", "Magahi", "Santali", "Kashmiri", "Nepali"]);

function isNonEmptyString(v){
    return typeof v === 'string' && v.trim() != '';
}

function isUUID(v) {
    return typeof v === 'string' && /^[0-9a-fA-F-]{36}$/.test(v);
}

function validateSubscriptionType(v) {
    return subscriptionTypes.has(v);
}

function validateUserType(v) {
    return userTypes.has(v);
}

function validateGender(v) {
    return genders.has(v);
}

function validateBillingCycle(v) {
    return billingCycles.has(v);
}

function validateArtistRoles(v) {
    return artistRoles.has(v);
}

function validateAudioExts(v) {
    return audioExts.has(v);
}

function validateLanguage(v) {
    return languages.has(v);
}

module.exports = {
    isUUID,
    isNonEmptyString,
    validateSubscriptionType,
    validateUserType,
    validateGender,
    validateBillingCycle,
    validateArtistRoles,
    validateAudioExts,
    validateLanguage
};