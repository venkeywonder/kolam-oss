<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Votes on poll cards (src/cards/poll.js). A poll card keeps its votes in data.votes: person id => {o: option ids,
 * n: their name, at: ms}. Votes go through this API rather than sync, so the rules hold on the server:
 * - commenters and up vote, each only for themselves;
 * - one answer unless the poll allows several, only options the poll still has;
 * - no votes once the poll has ended (data.closes, ms).
 * Sync keeps a poll's votes as they are on the server (Sync::stamp), so an edit of the card never undoes a vote.
 */
final class Polls
{
    private const MAX_OPTIONS = 100;

    private static function ms(): int { return (int) (microtime(true) * 1000); }

    /** Cast, change or take back your vote: {space, item, options: [option ids]}; no options takes it back. Returns the card. */
    public static function vote(array $u, array $in): array
    {
        $space = Access::space((string) ($in['space'] ?? ''));
        $item = $in['item'] ?? null;
        if (!is_string($item) || !preg_match('/^[\w.-]{1,64}$/', $item)) Http::fail(400, 'Invalid card');
        $picked = $in['options'] ?? null;
        if (!is_array($picked) || count($picked) > self::MAX_OPTIONS || array_filter($picked, fn($o) => !is_string($o))) Http::fail(400, 'Invalid vote');
        $picked = array_values(array_unique($picked));
        RateLimit::hit('vote:' . $u['id'], 300, 600);
        $card = Db::tx(function () use ($u, $space, $item, $picked) {
            $rev = Sync::bump($space['id']);   // first: serialises this write with pushes to the space
            $r = Db::one("SELECT parent, data FROM entities WHERE space_id = ? AND kind = 'item' AND id = ? AND deleted = 0", [$space['id'], $item])
                ?? Http::fail(404, 'Card not found');
            Access::need($u['id'], $space, (string) $r['parent'], 'commenter');
            $d = json_decode((string) $r['data'], true);
            if (!is_array($d) || ($d['type'] ?? '') !== 'poll' || !is_array($d['data'] ?? null)) Http::fail(422, 'That card isn’t a poll');
            $p = $d['data'];
            if (is_numeric($p['closes'] ?? null) && (int) $p['closes'] <= self::ms()) Http::fail(409, 'This poll has ended');
            $ids = [];
            foreach ((array) ($p['options'] ?? []) as $o) if (is_array($o) && is_string($o['id'] ?? null)) $ids[$o['id']] = true;
            foreach ($picked as $o) if (!isset($ids[$o])) Http::fail(409, 'That answer was just removed from the poll');
            if (empty($p['multi']) && count($picked) > 1) Http::fail(422, 'This poll takes one answer');
            $votes = is_array($p['votes'] ?? null) ? $p['votes'] : [];
            if ($picked) $votes[$u['id']] = ['o' => $picked, 'n' => (string) ($u['name'] ?? ''), 'at' => self::ms()];
            else unset($votes[$u['id']]);
            if ($votes) $d['data']['votes'] = $votes; else unset($d['data']['votes']);
            Sync::put($space['id'], $rev, 'item', $item, $d, (string) $r['parent'], $u['id'], true);
            return $d;
        });
        Realtime::nudge();
        return ['item' => $card];
    }

    /** Who picked each option: option id => voter names, in the order they voted. */
    public static function tally(array $data): array
    {
        $votes = array_filter(is_array($data['votes'] ?? null) ? $data['votes'] : [], 'is_array');
        uasort($votes, fn($a, $b) => ($a['at'] ?? 0) <=> ($b['at'] ?? 0));
        $out = [];
        foreach ($votes as $v) foreach ((array) ($v['o'] ?? []) as $o) if (is_string($o)) $out[$o][] = (string) ($v['n'] ?? '') ?: 'Someone';
        return $out;
    }

    /** An option as plain text: its words, then the people it names (a picture alone: "(picture)"). */
    public static function optionText(array $o): string
    {
        $ppl = array_map(fn($p) => '@' . ((string) ($p['n'] ?? '') ?: 'someone'), array_filter((array) ($o['ppl'] ?? []), 'is_array'));
        $t = trim((is_string($o['t'] ?? null) ? $o['t'] : '') . ' ' . implode(' ', $ppl));
        return $t !== '' ? $t : (!empty($o['img']) ? '(picture)' : '');
    }

    /** The options of a poll card's data, with an id each. */
    public static function options(array $data): array
    {
        return array_values(array_filter((array) ($data['options'] ?? []), fn($o) => is_array($o) && is_string($o['id'] ?? null)));
    }

    /** Searchable text: the question and the options. */
    public static function text(array $data): string
    {
        return trim((is_string($data['title'] ?? null) ? $data['title'] : '') . "\n" . implode("\n", array_map([self::class, 'optionText'], self::options($data))));
    }

    /** Markdown for exports: the question, then each option with its votes and who cast them. */
    public static function markdown(array $data): string
    {
        $who = self::tally($data);
        $lines = array_map(function ($o) use ($who) {
            $v = $who[$o['id']] ?? [];
            return '- ' . self::optionText($o) . ' — ' . count($v) . ' vote' . (count($v) === 1 ? '' : 's') . ($v ? ' (' . implode(', ', $v) . ')' : '');
        }, self::options($data));
        $closes = is_numeric($data['closes'] ?? null) ? (int) $data['closes'] : null;
        $end = $closes === null ? '' : "\n\n*" . ($closes <= self::ms() ? 'Ended ' : 'Ends ') . gmdate('Y-m-d H:i', intdiv($closes, 1000)) . ' UTC*';
        return '**' . ((is_string($data['title'] ?? null) && $data['title'] !== '') ? $data['title'] : 'Poll') . "**\n\n" . implode("\n", $lines) . $end;
    }
}
