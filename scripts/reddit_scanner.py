#!/usr/bin/env python3
"""
Reddit Pain Point Scanner — PRAW-based market intelligence
Called by FishbigAgent via child_process.

Usage:
    python reddit_scanner.py scan                          # Scan subreddits for opportunities
    python reddit_scanner.py scan --subs=SaaS,entrepreneur # Custom subreddits
    python reddit_scanner.py reply <post_id> <text>        # Reply (dry run)
    python reddit_scanner.py reply <post_id> <text> --live # Reply (real)
    python reddit_scanner.py warmup                        # Account warming actions
    python reddit_scanner.py status                        # Check account status
"""

import praw
import json
import sys
import os
import time
from datetime import datetime

# ─── Config ──────────────────────────────────────────────────

DEFAULT_SUBS = [
    "SideProject", "SaaS", "entrepreneur", "Automate",
    "smallbusiness", "startups", "webdev", "dataisbeautiful",
]

PAIN_KEYWORDS = [
    "is there a tool", "i need", "looking for", "anyone know",
    "does anyone", "how do i", "recommend", "alternative to",
    "automation", "ai tool", "workflow", "scraping", "monitoring",
    "competitor analysis", "market research", "price tracking",
    "data collection", "web scraping", "browser automation",
]

# ─── PRAW Init ───────────────────────────────────────────────

def get_reddit():
    """Initialize PRAW client from environment variables."""
    client_id = os.environ.get("REDDIT_CLIENT_ID")
    client_secret = os.environ.get("REDDIT_CLIENT_SECRET")
    username = os.environ.get("REDDIT_USERNAME")
    password = os.environ.get("REDDIT_PASSWORD")

    if not client_id or not client_secret:
        return None  # Read-only mode or not configured

    kwargs = {
        "client_id": client_id,
        "client_secret": client_secret,
        "user_agent": "market_research_assistant:v1.0 (by /u/{})".format(username or "fishbig"),
    }
    if username and password:
        kwargs["username"] = username
        kwargs["password"] = password

    return praw.Reddit(**kwargs)


# ─── Scan ────────────────────────────────────────────────────

def scan_opportunities(subreddits=None, keywords=None, limit=25):
    """Scan subreddits for posts matching pain point keywords."""
    reddit = get_reddit()
    if not reddit:
        return {"error": "Reddit credentials not configured. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET."}

    subs = subreddits or DEFAULT_SUBS
    kws = keywords or PAIN_KEYWORDS
    results = []

    for sub_name in subs:
        try:
            subreddit = reddit.subreddit(sub_name)
            for post in subreddit.new(limit=limit):
                text = (post.title + " " + (post.selftext or "")).lower()
                matched = [kw for kw in kws if kw in text]
                if matched:
                    results.append({
                        "id": post.id,
                        "title": post.title,
                        "body": (post.selftext or "")[:800],
                        "url": f"https://reddit.com{post.permalink}",
                        "subreddit": sub_name,
                        "score": post.score,
                        "num_comments": post.num_comments,
                        "created_utc": post.created_utc,
                        "age_hours": round((time.time() - post.created_utc) / 3600, 1),
                        "keywords_matched": matched,
                    })
        except Exception as e:
            results.append({"error": f"Failed to scan r/{sub_name}: {str(e)}"})

    # Sort by recency
    results.sort(key=lambda x: x.get("created_utc", 0), reverse=True)
    return results


# ─── Reply ───────────────────────────────────────────────────

def reply_to_post(post_id, reply_text, dry_run=True):
    """Reply to a Reddit post. Dry run by default."""
    reddit = get_reddit()
    if not reddit:
        return {"error": "Reddit credentials not configured."}

    try:
        submission = reddit.submission(id=post_id)

        # Check if already replied
        submission.comments.replace_more(limit=0)
        me = reddit.user.me()
        if me:
            already_replied = any(
                c.author and c.author.name == me.name
                for c in submission.comments.list()
            )
            if already_replied:
                return {"status": "skipped", "reason": "already_replied"}

        if dry_run:
            return {
                "status": "dry_run",
                "post_title": submission.title,
                "post_url": f"https://reddit.com{submission.permalink}",
                "would_reply": reply_text[:300],
            }

        # Real reply
        comment = submission.reply(reply_text)
        return {
            "status": "replied",
            "post_id": post_id,
            "comment_id": comment.id,
            "comment_url": f"https://reddit.com{comment.permalink}",
        }
    except Exception as e:
        return {"error": str(e)}


# ─── Warmup ──────────────────────────────────────────────────

def warmup_actions():
    """Perform account warming actions — browse and upvote."""
    reddit = get_reddit()
    if not reddit:
        return {"error": "Reddit credentials not configured."}

    try:
        me = reddit.user.me()
        karma = me.link_karma + me.comment_karma if me else 0

        # Get some popular posts to potentially upvote
        hot_posts = []
        for post in reddit.subreddit("all").hot(limit=5):
            hot_posts.append({
                "title": post.title[:100],
                "subreddit": str(post.subreddit),
                "score": post.score,
            })

        return {
            "status": "ok",
            "username": me.name if me else "unknown",
            "karma": karma,
            "account_age_days": round((time.time() - me.created_utc) / 86400, 1) if me else 0,
            "hot_posts_browsed": len(hot_posts),
            "suggestion": "Comment on these posts with genuine value to build karma" if karma < 100 else "Ready for targeted replies",
        }
    except Exception as e:
        return {"error": str(e)}


# ─── Account Status ──────────────────────────────────────────

def check_status():
    """Check Reddit account status and karma."""
    reddit = get_reddit()
    if not reddit:
        return {"error": "Reddit credentials not configured."}

    try:
        me = reddit.user.me()
        return {
            "username": me.name,
            "link_karma": me.link_karma,
            "comment_karma": me.comment_karma,
            "total_karma": me.link_karma + me.comment_karma,
            "account_age_days": round((time.time() - me.created_utc) / 86400, 1),
            "is_verified": me.has_verified_email,
            "ready_for_action": me.comment_karma >= 50,
        }
    except Exception as e:
        return {"error": str(e)}


# ─── CLI ─────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: reddit_scanner.py <scan|reply|warmup|status>"}))
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "scan":
        # Parse optional --subs=SaaS,entrepreneur
        subs = None
        for arg in sys.argv[2:]:
            if arg.startswith("--subs="):
                subs = arg.split("=", 1)[1].split(",")
        result = scan_opportunities(subreddits=subs)
        print(json.dumps(result, default=str))

    elif cmd == "reply":
        if len(sys.argv) < 4:
            print(json.dumps({"error": "Usage: reply <post_id> <text> [--live]"}))
            sys.exit(1)
        post_id = sys.argv[2]
        reply_text = sys.argv[3]
        dry_run = "--live" not in sys.argv
        result = reply_to_post(post_id, reply_text, dry_run)
        print(json.dumps(result, default=str))

    elif cmd == "warmup":
        result = warmup_actions()
        print(json.dumps(result, default=str))

    elif cmd == "status":
        result = check_status()
        print(json.dumps(result, default=str))

    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))
        sys.exit(1)
