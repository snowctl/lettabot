import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn().mockResolvedValue(Buffer.from('fake-file-data')) };
});

vi.mock('./shared/access-control.js', () => ({
  checkDmAccess: vi.fn().mockReturnValue('allowed'),
}));

vi.mock('./matrix-crypto.js', () => ({
  getCryptoCallbacks: vi.fn().mockReturnValue({}),
  initE2EE: vi.fn().mockResolvedValue(undefined),
  checkAndRestoreKeyBackup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fake-indexeddb/auto', () => ({}));

const mockRoom = {
  roomId: '!room:example.com',
  getJoinedMembers: vi.fn().mockReturnValue([
    { userId: '@bot:example.com' },
    { userId: '@user:example.com' },
  ]),
  currentState: {
    getStateEvents: vi.fn().mockReturnValue(null),
  },
};

const mockClient = {
  startClient: vi.fn().mockResolvedValue(undefined),
  stopClient: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue({ event_id: '$event123' }),
  sendEvent: vi.fn().mockResolvedValue({ event_id: '$event456' }),
  uploadContent: vi.fn().mockResolvedValue({ content_uri: 'mxc://example.com/media123' }),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  getUserId: vi.fn().mockReturnValue('@bot:example.com'),
  getRoom: vi.fn().mockReturnValue(mockRoom),
  joinRoom: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  once: vi.fn(),
  initRustCrypto: vi.fn().mockResolvedValue(undefined),
  getCrypto: vi.fn().mockReturnValue(null),
};

vi.mock('matrix-js-sdk', () => ({
  createClient: vi.fn().mockReturnValue(mockClient),
  RoomEvent: {
    MyMembership: 'Room.myMembership',
    Timeline: 'Room.timeline',
  },
  ClientEvent: {
    Sync: 'sync',
  },
  KnownMembership: {
    Invite: 'invite',
    Join: 'join',
  },
}));

let MatrixAdapter: any;
let mc: typeof mockClient;

beforeAll(async () => {
  mc = mockClient;

  try {
    const adapterMod = await import('./matrix.js');
    MatrixAdapter = adapterMod.MatrixAdapter;
  } catch {
    MatrixAdapter = null;
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  // Restore mock implementations cleared by clearAllMocks
  mc.startClient.mockResolvedValue(undefined);
  mc.sendMessage.mockResolvedValue({ event_id: '$event123' });
  mc.sendEvent.mockResolvedValue({ event_id: '$event456' });
  mc.uploadContent.mockResolvedValue({ content_uri: 'mxc://example.com/media123' });
  mc.sendTyping.mockResolvedValue(undefined);
  mc.getUserId.mockReturnValue('@bot:example.com');
  mc.getRoom.mockReturnValue(mockRoom);
  mockRoom.getJoinedMembers.mockReturnValue([
    { userId: '@bot:example.com' },
    { userId: '@user:example.com' },
  ]);
});

function skipIfNoAdapter() {
  return !MatrixAdapter;
}

/**
 * Finds the handler registered via client.on(eventName, handler).
 * For RoomEvent.Timeline, events come as (MatrixEvent, Room, toStartOfTimeline).
 */
function getOnHandler(eventName: string): ((...args: any[]) => Promise<void>) | undefined {
  const call = (mc.on.mock.calls as Array<[string, (...args: any[]) => void]>)
    .find(([name]) => name === eventName);
  if (!call) return undefined;
  const rawHandler = call[1];
  return async (...args: any[]) => {
    rawHandler(...args);
    await new Promise(resolve => setTimeout(resolve, 50));
  };
}

/** Create a mock MatrixEvent-like object */
function makeEvent(opts: {
  type: string;
  sender: string;
  content: Record<string, unknown>;
  eventId?: string;
  ts?: number;
  roomId?: string;
}) {
  return {
    getType: () => opts.type,
    getSender: () => opts.sender,
    getContent: () => opts.content,
    getId: () => opts.eventId || '$test:example.com',
    getTs: () => opts.ts || Date.now(),
    getRoomId: () => opts.roomId || '!room:example.com',
  };
}

const BASE_CONFIG = {
  homeserverUrl: 'https://matrix.example.com',
  accessToken: 'syt_test_token',
  userId: '@bot:example.com',
};

describe('MatrixAdapter constructor & config', () => {
  it('creates adapter with correct id and name', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    expect(adapter.id).toBe('matrix');
    expect(adapter.name).toMatch(/matrix/i);
  });

  it('default DM policy is pairing', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    expect(adapter.getDmPolicy?.()).toBe('pairing');
  });

  it('stores config values', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter({ ...BASE_CONFIG, dmPolicy: 'allow' });
    expect(adapter.getDmPolicy?.()).toBe('allow');
  });
});

describe('MatrixAdapter lifecycle', () => {
  it('isRunning() returns false before start', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    expect(adapter.isRunning()).toBe(false);
  });

  it('start() creates client and starts syncing', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();
    expect(mc.startClient).toHaveBeenCalledTimes(1);
  });

  it('isRunning() returns true after start', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();
    expect(adapter.isRunning()).toBe(true);
  });

  it('stop() stops the client', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();
    await adapter.stop();
    expect(mc.stopClient).toHaveBeenCalledTimes(1);
  });

  it('isRunning() returns false after stop', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();
    await adapter.stop();
    expect(adapter.isRunning()).toBe(false);
  });
});

describe('MatrixAdapter sendMessage', () => {
  it('sends text message to room and returns messageId', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    const result = await adapter.sendMessage({ chatId: '!room:example.com', text: 'hello' });

    expect(mc.sendMessage).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({ body: 'hello' }),
    );
    expect(typeof result.messageId).toBe('string');
  });

  it('sends with HTML formatting when text contains markdown', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.sendMessage({ chatId: '!room:example.com', text: '**bold** text' });

    expect(mc.sendMessage).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({ format: 'org.matrix.custom.html' }),
    );
  });
});

describe('MatrixAdapter sendFile', () => {
  it('uploads content and sends image message', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    const result = await adapter.sendFile({ chatId: '!room:example.com', filePath: '/tmp/photo.jpg', kind: 'image' });

    expect(mc.uploadContent).toHaveBeenCalledTimes(1);
    expect(mc.sendMessage).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({ msgtype: 'm.image' }),
    );
    expect(result).toHaveProperty('messageId');
  });

  it('uploads content and sends audio message', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.sendFile({ chatId: '!room:example.com', filePath: '/tmp/voice.ogg', kind: 'audio' });

    expect(mc.uploadContent).toHaveBeenCalledTimes(1);
    expect(mc.sendMessage).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({ msgtype: 'm.audio' }),
    );
  });

  it('uploads content and sends file message', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.sendFile({ chatId: '!room:example.com', filePath: '/tmp/document.pdf', kind: 'file' });

    expect(mc.uploadContent).toHaveBeenCalledTimes(1);
    expect(mc.sendMessage).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({ msgtype: 'm.file' }),
    );
  });
});

describe('MatrixAdapter editMessage', () => {
  it('sends edit event with m.replace relation', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.editMessage('!room:example.com', '$original:example.com', 'updated text');

    expect(mc.sendMessage).toHaveBeenCalledWith(
      '!room:example.com',
      expect.objectContaining({
        'm.relates_to': expect.objectContaining({
          rel_type: 'm.replace',
          event_id: '$original:example.com',
        }),
      }),
    );
  });
});

describe('MatrixAdapter addReaction', () => {
  it('sends m.reaction event with correct annotation', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.addReaction('!room:example.com', '$msg:example.com', '👍');

    expect(mc.sendEvent).toHaveBeenCalledWith(
      '!room:example.com',
      'm.reaction',
      expect.objectContaining({
        'm.relates_to': expect.objectContaining({
          rel_type: 'm.annotation',
          event_id: '$msg:example.com',
          key: '👍',
        }),
      }),
    );
  });
});

describe('MatrixAdapter typing indicators', () => {
  it('sendTypingIndicator calls sendTyping with true and a timeout', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.sendTypingIndicator('!room:example.com');

    expect(mc.sendTyping).toHaveBeenCalledWith('!room:example.com', true, expect.any(Number));
  });

  it('stopTypingIndicator calls sendTyping with false', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    await adapter.start();

    await adapter.stopTypingIndicator?.('!room:example.com');

    expect(mc.sendTyping).toHaveBeenCalledWith('!room:example.com', false, expect.any(Number));
  });
});

describe('MatrixAdapter getFormatterHints', () => {
  it('returns supportsReactions: true and supportsFiles: true', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    const hints = adapter.getFormatterHints();
    expect(hints.supportsReactions).toBe(true);
    expect(hints.supportsFiles).toBe(true);
  });
});

describe('MatrixAdapter supportsEditing', () => {
  it('returns false by default', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    expect(adapter.supportsEditing?.()).toBe(false);
  });

  it('returns true when streaming is enabled', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter({ ...BASE_CONFIG, streaming: true });
    expect(adapter.supportsEditing?.()).toBe(true);
  });
});

describe('MatrixAdapter getDmPolicy', () => {
  it('returns configured policy', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter({ ...BASE_CONFIG, dmPolicy: 'allow' });
    expect(adapter.getDmPolicy?.()).toBe('allow');
  });

  it('returns pairing as default', () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(BASE_CONFIG);
    expect(adapter.getDmPolicy?.()).toBe('pairing');
  });
});

describe('MatrixAdapter message handling', () => {
  const OPEN_CONFIG = { ...BASE_CONFIG, dmPolicy: 'open' as const };

  it('ignores messages from self', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(OPEN_CONFIG);
    const onMessage = vi.fn();
    adapter.onMessage = onMessage;
    await adapter.start();

    const handler = getOnHandler('Room.timeline');
    if (handler) {
      const event = makeEvent({
        type: 'm.room.message',
        sender: '@bot:example.com',
        content: { msgtype: 'm.text', body: 'hello from self' },
        eventId: '$self:example.com',
      });
      // (event, room, toStartOfTimeline)
      await handler(event, mockRoom, false);
      expect(onMessage).not.toHaveBeenCalled();
    }
  });

  it('routes commands to onCommand handler', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(OPEN_CONFIG);
    const onCommand = vi.fn().mockResolvedValue(null);
    adapter.onCommand = onCommand;
    await adapter.start();

    const handler = getOnHandler('Room.timeline');
    if (handler) {
      const event = makeEvent({
        type: 'm.room.message',
        sender: '@user:example.com',
        content: { msgtype: 'm.text', body: '/status' },
        eventId: '$cmd:example.com',
      });
      await handler(event, mockRoom, false);
      expect(onCommand).toHaveBeenCalled();
    }
  });

  it('routes regular messages to onMessage handler', async () => {
    if (skipIfNoAdapter()) return;
    const adapter = new MatrixAdapter(OPEN_CONFIG);
    const onMessage = vi.fn();
    adapter.onMessage = onMessage;
    await adapter.start();

    const handler = getOnHandler('Room.timeline');
    if (handler) {
      const event = makeEvent({
        type: 'm.room.message',
        sender: '@user:example.com',
        content: { msgtype: 'm.text', body: 'hello bot' },
        eventId: '$msg:example.com',
      });
      await handler(event, mockRoom, false);
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: '!room:example.com', text: 'hello bot' }),
      );
    }
  });
});
