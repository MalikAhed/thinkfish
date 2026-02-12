const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize clients for each provider
const clients = {
    openai: new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    }),
    anthropic: new OpenAI({
        baseURL: 'https://api.anthropic.com/v1/',
        apiKey: process.env.ANTHROPIC_API_KEY
    })
};

// Model configuration: maps display name to provider and actual model ID
const modelConfig = {
    'chatgpt-5': { provider: 'openai', modelId: 'gpt-5.2-2025-12-11' },
    'chatgpt-5-mini': { provider: 'openai', modelId: 'gpt-5-mini-2025-08-07' },
    'claude-sonnet-4-5': { provider: 'anthropic', modelId: 'claude-sonnet-4-5-20250929' },
    'claude-haiku-4-5': { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' }
};

function getClientAndModel(modelName) {
    const config = modelConfig[modelName];
    if (!config) {
        throw new Error(`Unknown model: ${modelName}`);
    }
    return {
        client: clients[config.provider],
        modelId: config.modelId
    };
}

function stripMarkdownCodeBlock(text) {
    return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

// Middleware
app.use(cors());
app.use(express.json());

// Apply required headers globally for all responses
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});


// Serve static frontend files
// app.use(express.static(path.join(__dirname, 'public/')));
app.use(express.static('public'));

app.post('/api/explain-move', async (req, res) => {
    const { model, mate, fen, move, bestMove, continuation, additionalContext } = req.body;

    if (!fen || !move || !bestMove) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }


    console.log("Received request:", { fen, move, bestMove });  // Log request

    // const systemPrompt = `
    //     You are a chess analyst at grand master level and consistently beat Stockfish.
    //     Your job is to explain the best move provided by Stockfish, explain the WHY behind it
    //     If user's provided move is DIFFERENT from the best move, also explain WHY the best move
    //     is better and if user's move is actually a good or bad move and make it VERY CLEAR that
    //     which is best move. For example:
    //
    //     "Black move xx is good/bad because it causes double pawn [further details].
    //     Whereas the move zz is better because [detailed reasons]"
    //
    //     User will provide the move in JSON format as follow (including current FEN state)
    //     {
    //         "fen": "[fen state]"
    //         "color": "[color]"
    //         "move": "[pgn move]"
    //         "bestMove": "[best move in UCI format]"
    //     }
    //
    //     The user will indicate which color does the user play and what is the current FEN state
    //
    //     Do note that bestMove input is in UCI format, always transform this into PGN format (a5c4 into Nc4 if knight was in a5)
    //
    //     Provide a JSON response structured as follows:
    //     {
    //         "explanation": "[Provide an explanation for the move]"
    //         "possibleContinuations" [
    //             {
    //                 "moves": [
    //                     {"move": "[PGN format]", "color": "white", "reason": "[Explain why]"},
    //                     {"move": "[PGN format for opponent]", "color": "black", "reason": "[Explain why]"},
    //                     ...
    //                 ]
    //             },
    //             {
    //                 "moves": [
    //                     {"move": "[PGN format]", "color": "white", "reason": "[Explain why]"},
    //                     {"move": "[PGN format for opponent]", "color": "black", "reason": "[Explain why]"},
    //                     ...
    //                 ]
    //             }
    //         ]
    //     }
    //
    //     Only give UP TO MAXIMUM 1 possible continuation from the best move. For EACH continuation go
    //     UP to 8 DEPTHS (8 moves)
    //
    //     VERY IMPORTANT
    //     Possible continuations AND explanations MUST BE VALID based on the
    //     given FEN position. When explaining pieces, make sure the pieces are
    //     referenced correctly based on the FEN position. For example:
    //     1. DO NOT mention knight on f8 when it is actually bishop on f8)
    //     2. DO NOT offer castling when FEN already indicated there is no castling right (one side or both)
    //     3. ALWAYS validate the explanation and possible continuations
    //     4. ALL explanation only use PGN. Do NOT USE UCI format
    // `.trim();


    const systemPrompt = `You are a chess analyst helping players understand positions and moves.

TASK: Analyze the chess position and explain what both moves accomplish.

INPUT (JSON):
{
    "move": { "pgn": "...", "before_fen": "...", "after_fen": "..." },
    "bestMove": { "pgn": "...", "before_fen": "...", "after_fen": "..." },
    "continuation": [{ "pgn": "...", "before_fen": "...", "after_fen": "..." }, ...],
    "color": "w|b",
    "mate": "negative = opponent has forced mate in X, positive = current player has forced mate in X, 0 = no forced mate",
    "additionalContext": "..."
}

OUTPUT: Return ONLY raw JSON. Do NOT wrap in markdown code blocks. Do NOT use \`\`\` fences.
{
    "position_summary": "Brief description of the position before the move (2-3 sentences)",
    "played_move_analysis": "What the played move accomplishes",
    "best_move_analysis": "What the best move accomplishes",
    "key_difference": "Main difference between the moves. Be honest if subtle.",
    "continuation_explanation": "Overall plan shown in the continuation (not move-by-move)",
    "continuation_moves": [
        { "move": "Nc4", "color": "black", "purpose": "What this accomplishes" }
    ]
}

CRITICAL RULES:
1. Base analysis ONLY on FEN positions provided - never assume piece locations
2. Before claiming any tactic, verify material count in before/after FEN matches your claim
3. Look for: material changes, tactical patterns (pins, forks, discovered attacks), positional features (weak squares, outposts, open files), piece activity, pawn structure
4. If mate != 0: focus on the mating attack or defense
5. If moves seem equally valid: say "Both moves are reasonable, engine prefers X because [observable pattern]"
6. For continuation_moves: only explain moves with clear tactical purpose (captures, checks, threats). Maximum 4 moves.
7. Never claim certainty about deep positional compensation - acknowledge when it requires calculation
8. Verify piece locations against FEN before mentioning them

WHEN TO BE HONEST:
- If eval difference is small and no clear tactics: "The difference is subtle and requires deep calculation"
- If position is complex: "This position has multiple strategic ideas"
- If you're unsure: Don't guess. Say "The advantage here is not immediately clear"
`.trim();

    const userPrompt = JSON.stringify({
        fen,
        move: {
            pgn: move.san,
            before_fen: move.before,
            after_fen: move.after,
            mate,
        },
        color: move.color,
        bestMove,
        continuation,
        additionalContext
    });

    try {
        const { client, modelId } = getClientAndModel(model || 'claude-sonnet-4-5');
        console.log(`Sending request to ${model} (${modelId})`);
        console.dir(JSON.parse(userPrompt));
        const stream = await client.chat.completions.create({
            model: modelId,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.3,
            stream: true,
        });

        let responseChunks = [];
        for await (const chunk of stream) {
            const text = chunk.choices[0]?.delta?.content;
            if (text) {
                responseChunks.push(text);
                process.stdout.write(text); // Debugging
            }
        }
        console.log("\n--- Streaming complete ---");

        // Combine all chunks into a single string and parse as JSON
        const fullResponse = stripMarkdownCodeBlock(responseChunks.join(""));
        const parsedJson = JSON.parse(fullResponse);

        return res.json(parsedJson); // Send clean JSON to frontend

    } catch (error) {
        console.error('Error fetching explanation:', error);
        return res.status(500).json({ error: 'Failed to generate explanation' });
    }
});

app.post('/api/review', async (req, res) => {
    const { reviewType, moves, model, additionalContext } = req.body;

    if (!reviewType || !moves) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    console.log("Received request:", { reviewType, moves });  // Log request

    let systemPrompt = `You are a chess analyst reviewing a game to help players improve.

TASK: Identify key moments and patterns in the game based on evaluation swings.

INPUT (JSON):
{
    "moves": [
        { "pgn": "...", "before_fen": "...", "after_fen": "...", "evalScore": 0.5, "mate": 0 },
        ...
    ],
    "additionalContext": "..."
}

Note: evalScore ranges from -8.0 to 8.0 (negative = black advantage, positive = white advantage).
- Eval going MORE NEGATIVE = good for Black, bad for White
- Eval going MORE POSITIVE = good for White, bad for Black
- Example: +0.36 to -1.19 means Black made a GOOD move (gained 1.55 points), NOT a blunder
- Example: -0.50 to +1.00 means White made a GOOD move (gained 1.50 points)
mate: negative = opponent has forced mate, positive = current player has forced mate, 0 = no forced mate.

OUTPUT: Return ONLY raw JSON. Do NOT wrap in markdown code blocks. Do NOT use \`\`\` fences.
{
    "explanation": "Multi-paragraph review with clear sections (use \\n\\n for separation)"
}

STRUCTURE YOUR REVIEW (keep concise - aim for 300-400 words total):
1. Opening: 2-3 sentences on development and early mistakes
2. Middlegame: Focus only on the 2-3 biggest eval swings
3. Endgame: Brief note if applicable
4. Key Takeaways: 2-3 bullet points on what each player should learn

Do NOT narrate every move. Focus only on critical turning points.

CRITICAL RULES:
1. Focus on moves where eval swings >1.5 - these are likely blunders or brilliant moves
2. For each critical moment, describe what changed between before_fen and after_fen
3. Look for patterns: material loss, tactical shots (pins, forks, discovered attacks), positional features (weak squares, outposts, open files)
4. DO NOT assume piece positions - verify against FEN
5. If many small mistakes: say "Accumulated small inaccuracies" rather than inventing specific errors
6. Be specific: "Move 15 (Nf6) allowed a discovered attack" not "Poor piece placement throughout"
7. For longer games (30+ moves), focus analysis on the 3-5 most critical positions rather than explaining every phase

ANALYSIS APPROACH:
- Large eval drop (>2.0): Likely hanging piece or tactical shot - verify material in FENs
- Gradual eval decline: Positional pressure - describe observable features (weak squares, bad pieces)
- Eval spike in opponent's favor: Missed tactic - check for checks, captures, threats in that position
- Stable eval with fluctuations: Balanced game - focus on plans and transitions

HONESTY:
- If you can't identify why eval changed: "The evaluation shift here is not immediately obvious"
- If multiple moves seem equally problematic: "Several inaccuracies in this phase"
- Don't invent specific tactical patterns unless you can verify them in the FEN
`.trim();

    if (reviewType === 'overall') {
        systemPrompt += `

FOCUS: Balanced review of both players.
- Compare how both players handled opening, middlegame, endgame
- Identify who made more critical mistakes (use evalScore swings)
- Note any missed winning chances or defensive resources
- Keep it balanced - even the winner made mistakes
`.trim();
    } else if (reviewType === 'white' || reviewType === 'black') {
        systemPrompt += `

FOCUS: ${reviewType}'s performance only.
- What did ${reviewType} do well?
- Where did ${reviewType} go wrong? (focus on evalScore drops for ${reviewType})
- What should ${reviewType} practice based on this game?
- Even if ${reviewType} won, identify improvement areas
`.trim();
    } else {
        return res.status(400).json({error: 'Invalid review type: ' + reviewType})
    }

    const userPrompt = JSON.stringify({
        moves,
        additionalContext
    });

    try {
        const { client, modelId } = getClientAndModel(model || 'claude-sonnet-4-5');
        console.log(`Sending request to ${model} (${modelId})`);
        console.dir(JSON.parse(userPrompt));
        const stream = await client.chat.completions.create({
            model: modelId,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.3,
            stream: true,
        });

        let responseChunks = [];
        for await (const chunk of stream) {
            const text = chunk.choices[0]?.delta?.content;
            if (text) {
                responseChunks.push(text);
                process.stdout.write(text); // Debugging
            }
        }
        console.log("\n--- Streaming complete ---");

        // Combine all chunks into a single string and parse as JSON
        const fullResponse = stripMarkdownCodeBlock(responseChunks.join(""));
        const parsedJson = JSON.parse(fullResponse);

        return res.json(parsedJson); // Send clean JSON to frontend

    } catch (error) {
        console.error('Error fetching explanation:', error);
        return res.status(500).json({ error: 'Failed to generate explanation' });
    }
});



app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});




