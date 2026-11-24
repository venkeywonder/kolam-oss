<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Model Context Protocol server: Streamable HTTP at /api/mcp (JSON responses, no SSE stream) for MCP clients signed in with
 * OAuth or an access key. It reads and changes one user's boards.
 */
final class Mcp
{
    private const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    /** Classes that each offer some tools: definitions() for tools/list, call($u, $name, $args) to run one of theirs. */
    private const MODULES = [BoardTools::class, LayoutTools::class, TemplateTools::class, HistoryTools::class, PeopleTools::class];

    public static function handle(array $u): never
    {
        if (Http::method() !== 'POST') {
            header('Allow: POST');
            Http::json(['error' => 'This MCP endpoint accepts POST only'], 405);
        }
        $raw = file_get_contents('php://input', false, null, 0, 4 * 1024 * 1024);
        $msg = json_decode((string) $raw, true);
        if (!is_array($msg)) Http::json(self::error(null, -32700, 'Parse error'), 400);
        $batch = array_is_list($msg);
        $out = [];
        foreach ($batch ? $msg : [$msg] as $m) {
            $r = is_array($m) ? self::reply($u, $m) : self::error(null, -32600, 'Invalid request');
            if ($r !== null) $out[] = $r;
        }
        if (!$out) { http_response_code(202); exit; }   // only notifications
        Http::json($batch ? $out : $out[0]);
    }

    /** The JSON-RPC response to one message, or null for a notification. */
    public static function reply(array $u, array $m): ?array
    {
        $id = $m['id'] ?? null;
        $method = $m['method'] ?? '';
        $p = is_array($m['params'] ?? null) ? $m['params'] : [];
        if (!array_key_exists('id', $m)) return null;   // notification (initialized, cancelled…)
        try {
            $result = match ($method) {
                'initialize' => [
                    'protocolVersion' => in_array($p['protocolVersion'] ?? '', self::VERSIONS, true) ? $p['protocolVersion'] : self::VERSIONS[1],
                    'capabilities' => ['tools' => ['listChanged' => false], 'prompts' => ['listChanged' => false]],
                    'serverInfo' => ['name' => 'kolam', 'title' => 'Kolam', 'version' => '2.0.0'],
                    'instructions' => BoardTools::INSTRUCTIONS,
                ],
                'ping' => new \stdClass(),
                'tools/list' => ['tools' => array_merge(...array_map(fn($c) => $c::definitions(), self::MODULES))],
                'tools/call' => self::call($u, $p),
                'prompts/list' => ['prompts' => McpPrompts::definitions()],
                'prompts/get' => McpPrompts::get((string) ($p['name'] ?? ''), is_array($p['arguments'] ?? null) ? $p['arguments'] : []),
                default => null,
            };
        } catch (ToolError $e) {   // a prompt that doesn't exist or is missing an argument
            return self::error($id, -32602, $e->getMessage());
        } catch (HttpError $e) {
            return self::error($id, -32603, $e->getMessage());
        }
        return $result === null ? self::error($id, -32601, "Method not found: $method") : ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result];
    }

    private static function call(array $u, array $p): array
    {
        $name = (string) ($p['name'] ?? '');
        $args = is_array($p['arguments'] ?? null) ? $p['arguments'] : [];
        try {
            $data = self::module($name)::call($u, $name, $args);
            $text = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            return ['content' => [['type' => 'text', 'text' => $text]]];
        } catch (ToolError | HttpError $e) {
            return ['content' => [['type' => 'text', 'text' => 'Error: ' . $e->getMessage()]], 'isError' => true];
        }
    }

    /** The class that offers tool $name. */
    private static function module(string $name): string
    {
        foreach (self::MODULES as $c) {
            foreach ($c::definitions() as $d) if ($d['name'] === $name) return $c;
        }
        throw new ToolError("Unknown tool $name");
    }

    private static function error(mixed $id, int $code, string $message): array
    {
        return ['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => $code, 'message' => $message]];
    }
}
