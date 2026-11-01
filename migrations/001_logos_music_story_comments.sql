-- ---------- 1. School logos ----------
alter table schools add column if not exists logo_url text;
alter table schools add column if not exists logo_public_id text;

-- ---------- 2. Music on posts and stories ----------
alter table posts   add column if not exists audio_url text;
alter table posts   add column if not exists audio_public_id text;
alter table posts   add column if not exists audio_title text check (char_length(audio_title) <= 80);
alter table posts   add column if not exists audio_duration numeric;

alter table stories add column if not exists audio_url text;
alter table stories add column if not exists audio_public_id text;
alter table stories add column if not exists audio_title text check (char_length(audio_title) <= 80);
alter table stories add column if not exists audio_duration numeric;

-- ---------- 3. Story comments ----------
create table if not exists story_comments (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references stories(id) on delete cascade,
  author_id uuid not null references profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  moderation_status text not null default 'ok' check (moderation_status in ('ok','flagged','removed')),
  created_at timestamptz not null default now()
);
create index if not exists story_comments_story_idx on story_comments(story_id, created_at);

-- ---------- 4. Likes on comments ----------
create table if not exists comment_likes (
  comment_id uuid not null references comments(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index if not exists comment_likes_comment_idx on comment_likes(comment_id);

create table if not exists story_comment_likes (
  comment_id uuid not null references story_comments(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index if not exists story_comment_likes_comment_idx on story_comment_likes(comment_id);

-- ---------- 5. Reports can point at a story comment ----------
alter table reports drop constraint if exists reports_target_type_check;
alter table reports add constraint reports_target_type_check
  check (target_type in ('post','comment','profile','message','event','story','reel','story_comment'));

-- ---------- 6. Row Level Security ----------
alter table story_comments enable row level security;
alter table comment_likes enable row level security;
alter table story_comment_likes enable row level security;

drop policy if exists story_comments_read on story_comments;
create policy story_comments_read on story_comments for select to authenticated
  using (author_id = auth.uid()
         or exists (select 1 from stories s where s.id = story_id and s.author_id = auth.uid()));
drop policy if exists story_comments_write on story_comments;
create policy story_comments_write on story_comments for insert to authenticated with check (author_id = auth.uid());
drop policy if exists story_comments_delete on story_comments;
create policy story_comments_delete on story_comments for delete to authenticated using (author_id = auth.uid());

drop policy if exists comment_likes_read on comment_likes;
create policy comment_likes_read on comment_likes for select to authenticated using (true);
drop policy if exists comment_likes_own on comment_likes;
create policy comment_likes_own on comment_likes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists story_comment_likes_own on story_comment_likes;
create policy story_comment_likes_own on story_comment_likes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

notify pgrst, 'reload schema';
