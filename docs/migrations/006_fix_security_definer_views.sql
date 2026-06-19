-- Migration 006: Fix Security Definer Views
-- Converts views to use security_invoker = true to enforce RLS and user permissions.

ALTER VIEW public.v_user_top_artists SET (security_invoker = true);
ALTER VIEW public.v_user_liked_tracks_with_features SET (security_invoker = true);
ALTER VIEW public.v_user_recent_plays SET (security_invoker = true);
ALTER VIEW public.v_user_genre_profile SET (security_invoker = true);
