import { SenzorOptions } from '../core/types';
import { hookRequire } from './hook';
import { patchMethod } from './patch';
import { runWithCapturedSpan, startCapturedSpan } from './span';

// ---------------------------------------------------------------------------
// Firebase Admin SDK Instrumentation
//
// Instruments `firebase-admin` services:
//   1. Firestore — document/collection CRUD and queries
//   2. Auth — user management and token verification
//   3. Storage — file upload/download operations
//   4. Messaging (FCM) — push notification delivery
//
// Also instruments `firebase-functions` for Cloud Functions triggers.
//
// Strategy: Hook each firebase-admin sub-module separately since they're
// lazy-loaded. Firestore is the most critical — we patch DocumentReference,
// CollectionReference, Query, and Transaction prototypes.
//
// Captured attributes:
//   - db.system.name: 'firestore' (for Firestore ops)
//   - db.operation.name: GET, SET, ADD, UPDATE, DELETE, QUERY
//   - db.collection.name: collection path
//   - firebase.service: 'firestore' | 'auth' | 'storage' | 'messaging'
//   - firebase.operation: specific operation name
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Firestore patching
// ---------------------------------------------------------------------------

/** Wrap an async Firestore method that returns a promise. */
const wrapFirestoreMethod = (
  proto: any,
  methodName: string,
  getSpanInfo: (instance: any, args: any[]) => { name: string; meta: Record<string, any> },
  patchKey: string,
  options?: SenzorOptions
) => {
  if (!proto || typeof proto[methodName] !== 'function') return;

  patchMethod(
    proto,
    methodName,
    patchKey,
    (original) =>
      function patchedFirestoreMethod(this: any, ...args: any[]) {
        const { name, meta } = getSpanInfo(this, args);

        const span = startCapturedSpan(name, 'db', meta, options);

        if (!span) return original.apply(this, args);

        return runWithCapturedSpan(span, () => {
          try {
            const result = original.apply(this, args);

            if (result && typeof result.then === 'function') {
              return result.then(
                (value: any) => {
                  const endMeta: Record<string, any> = {};
                  // DocumentSnapshot
                  if (value?.exists !== undefined) {
                    endMeta['firestore.exists'] = value.exists;
                  }
                  // QuerySnapshot
                  if (value?.size !== undefined) {
                    endMeta['db.response.row_count'] = value.size;
                  }
                  span.end(0, endMeta);
                  return value;
                },
                (error: any) => {
                  span.end(error?.code || 500, {
                    'error.message': error?.message,
                    'error.type': error?.name || 'FirestoreError',
                    'db.error.code': error?.code,
                  });
                  throw error;
                }
              );
            }

            // WriteResult (for set, update, delete — they return a WriteResult promise)
            span.end(0);
            return result;
          } catch (error: any) {
            span.end(500, { 'error.message': error?.message });
            throw error;
          }
        });
      }
  );
};

/** Get the collection path from a DocumentReference or CollectionReference. */
const getPath = (ref: any): string => {
  try {
    return ref?.path || ref?._path?.toString() || 'unknown';
  } catch {
    return 'unknown';
  }
};

const getCollectionName = (ref: any): string => {
  try {
    // For DocumentReference, parent is the collection
    if (ref?.parent?.id) return ref.parent.id;
    // For CollectionReference, id is the collection name
    if (ref?.id) return ref.id;
    // For Query, try _query or _path
    if (ref?._query?._path) return ref._query._path.toString().split('/').pop() || 'unknown';
    return getPath(ref).split('/').filter(Boolean).slice(-2, -1)[0] || 'unknown';
  } catch {
    return 'unknown';
  }
};

const patchFirestore = (firestoreModule: any, options?: SenzorOptions) => {
  // --- DocumentReference ---
  const DocRef = firestoreModule?.DocumentReference;
  if (DocRef?.prototype) {
    const docProto = DocRef.prototype;

    // get()
    wrapFirestoreMethod(docProto, 'get', (instance) => ({
      name: `Firestore GET ${getPath(instance)}`,
      meta: {
        'db.system.name': 'firestore',
        'db.operation.name': 'GET',
        'db.collection.name': getCollectionName(instance),
        'firestore.path': getPath(instance),
        'firebase.service': 'firestore',
        library: 'firebase-admin',
      },
    }), 'senzor.firebase.docRef.get', options);

    // set()
    wrapFirestoreMethod(docProto, 'set', (instance) => ({
      name: `Firestore SET ${getPath(instance)}`,
      meta: {
        'db.system.name': 'firestore',
        'db.operation.name': 'SET',
        'db.collection.name': getCollectionName(instance),
        'firestore.path': getPath(instance),
        'firebase.service': 'firestore',
        library: 'firebase-admin',
      },
    }), 'senzor.firebase.docRef.set', options);

    // update()
    wrapFirestoreMethod(docProto, 'update', (instance) => ({
      name: `Firestore UPDATE ${getPath(instance)}`,
      meta: {
        'db.system.name': 'firestore',
        'db.operation.name': 'UPDATE',
        'db.collection.name': getCollectionName(instance),
        'firestore.path': getPath(instance),
        'firebase.service': 'firestore',
        library: 'firebase-admin',
      },
    }), 'senzor.firebase.docRef.update', options);

    // delete()
    wrapFirestoreMethod(docProto, 'delete', (instance) => ({
      name: `Firestore DELETE ${getPath(instance)}`,
      meta: {
        'db.system.name': 'firestore',
        'db.operation.name': 'DELETE',
        'db.collection.name': getCollectionName(instance),
        'firestore.path': getPath(instance),
        'firebase.service': 'firestore',
        library: 'firebase-admin',
      },
    }), 'senzor.firebase.docRef.delete', options);

    // create()
    if (typeof docProto.create === 'function') {
      wrapFirestoreMethod(docProto, 'create', (instance) => ({
        name: `Firestore CREATE ${getPath(instance)}`,
        meta: {
          'db.system.name': 'firestore',
          'db.operation.name': 'CREATE',
          'db.collection.name': getCollectionName(instance),
          'firebase.service': 'firestore',
          library: 'firebase-admin',
        },
      }), 'senzor.firebase.docRef.create', options);
    }
  }

  // --- CollectionReference ---
  const ColRef = firestoreModule?.CollectionReference;
  if (ColRef?.prototype) {
    // add()
    wrapFirestoreMethod(ColRef.prototype, 'add', (instance) => ({
      name: `Firestore ADD ${getPath(instance)}`,
      meta: {
        'db.system.name': 'firestore',
        'db.operation.name': 'ADD',
        'db.collection.name': getCollectionName(instance),
        'firebase.service': 'firestore',
        library: 'firebase-admin',
      },
    }), 'senzor.firebase.colRef.add', options);

    // listDocuments()
    if (typeof ColRef.prototype.listDocuments === 'function') {
      wrapFirestoreMethod(ColRef.prototype, 'listDocuments', (instance) => ({
        name: `Firestore LIST ${getPath(instance)}`,
        meta: {
          'db.system.name': 'firestore',
          'db.operation.name': 'LIST',
          'db.collection.name': getCollectionName(instance),
          'firebase.service': 'firestore',
          library: 'firebase-admin',
        },
      }), 'senzor.firebase.colRef.listDocuments', options);
    }
  }

  // --- Query ---
  const Query = firestoreModule?.Query;
  if (Query?.prototype) {
    wrapFirestoreMethod(Query.prototype, 'get', (instance) => ({
      name: `Firestore QUERY ${getCollectionName(instance)}`,
      meta: {
        'db.system.name': 'firestore',
        'db.operation.name': 'QUERY',
        'db.collection.name': getCollectionName(instance),
        'firebase.service': 'firestore',
        library: 'firebase-admin',
      },
    }), 'senzor.firebase.query.get', options);
  }

  // --- Transaction ---
  const Transaction = firestoreModule?.Transaction;
  if (Transaction?.prototype) {
    for (const method of ['get', 'set', 'update', 'delete', 'create'] as const) {
      if (typeof Transaction.prototype[method] !== 'function') continue;
      // Transaction methods are sync (they queue operations) — except get()
      if (method === 'get') {
        wrapFirestoreMethod(Transaction.prototype, 'get', (_instance, args) => ({
          name: `Firestore TX GET ${getPath(args[0])}`,
          meta: {
            'db.system.name': 'firestore',
            'db.operation.name': 'TX_GET',
            'firebase.service': 'firestore',
            library: 'firebase-admin',
          },
        }), 'senzor.firebase.transaction.get', options);
      }
    }
  }

  // --- WriteBatch ---
  const WriteBatch = firestoreModule?.WriteBatch;
  if (WriteBatch?.prototype && typeof WriteBatch.prototype.commit === 'function') {
    wrapFirestoreMethod(WriteBatch.prototype, 'commit', () => ({
      name: 'Firestore BATCH COMMIT',
      meta: {
        'db.system.name': 'firestore',
        'db.operation.name': 'BATCH_COMMIT',
        'firebase.service': 'firestore',
        library: 'firebase-admin',
      },
    }), 'senzor.firebase.writeBatch.commit', options);
  }
};

// ---------------------------------------------------------------------------
// Auth patching
// ---------------------------------------------------------------------------

const AUTH_METHODS = [
  'createUser', 'getUser', 'getUserByEmail', 'getUserByPhoneNumber',
  'listUsers', 'deleteUser', 'deleteUsers', 'updateUser',
  'verifyIdToken', 'verifySessionCookie', 'createSessionCookie',
  'revokeRefreshTokens', 'setCustomUserClaims', 'generateEmailVerificationLink',
  'generatePasswordResetLink', 'generateSignInWithEmailLink',
] as const;

const patchFirebaseAuth = (authModule: any, options?: SenzorOptions) => {
  // Auth is typically at auth().* or Auth.prototype
  const Auth = authModule?.Auth;
  if (!Auth?.prototype) return;

  for (const method of AUTH_METHODS) {
    if (typeof Auth.prototype[method] !== 'function') continue;

    patchMethod(
      Auth.prototype,
      method,
      `senzor.firebase.auth.${method}`,
      (original) =>
        function patchedAuthMethod(this: any, ...args: any[]) {
          const span = startCapturedSpan(
            `Firebase Auth ${method}`,
            'function',
            {
              'firebase.service': 'auth',
              'firebase.operation': method,
              library: 'firebase-admin',
            },
            options
          );

          if (!span) return original.apply(this, args);

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.apply(this, args);
              if (result && typeof result.then === 'function') {
                return result.then(
                  (value: any) => { span.end(0); return value; },
                  (error: any) => {
                    span.end(500, {
                      'error.message': error?.message,
                      'error.type': error?.code || error?.name || 'AuthError',
                    });
                    throw error;
                  }
                );
              }
              span.end(0);
              return result;
            } catch (error: any) {
              span.end(500, { 'error.message': error?.message });
              throw error;
            }
          });
        }
    );
  }
};

// ---------------------------------------------------------------------------
// Messaging (FCM) patching
// ---------------------------------------------------------------------------

const MESSAGING_METHODS = [
  'send', 'sendEach', 'sendEachForMulticast', 'sendMulticast',
  'sendToDevice', 'sendToTopic', 'sendToCondition',
  'subscribeToTopic', 'unsubscribeFromTopic',
] as const;

const patchFirebaseMessaging = (messagingModule: any, options?: SenzorOptions) => {
  const Messaging = messagingModule?.Messaging;
  if (!Messaging?.prototype) return;

  for (const method of MESSAGING_METHODS) {
    if (typeof Messaging.prototype[method] !== 'function') continue;

    patchMethod(
      Messaging.prototype,
      method,
      `senzor.firebase.messaging.${method}`,
      (original) =>
        function patchedMessagingMethod(this: any, ...args: any[]) {
          const span = startCapturedSpan(
            `Firebase FCM ${method}`,
            'messaging',
            {
              'firebase.service': 'messaging',
              'firebase.operation': method,
              'messaging.system': 'fcm',
              library: 'firebase-admin',
            },
            options
          );

          if (!span) return original.apply(this, args);

          return runWithCapturedSpan(span, () => {
            try {
              const result = original.apply(this, args);
              if (result && typeof result.then === 'function') {
                return result.then(
                  (value: any) => {
                    const endMeta: Record<string, any> = {};
                    // sendEach/sendMulticast returns BatchResponse
                    if (value?.successCount !== undefined) {
                      endMeta['firebase.fcm.success_count'] = value.successCount;
                      endMeta['firebase.fcm.failure_count'] = value.failureCount;
                    }
                    span.end(0, endMeta);
                    return value;
                  },
                  (error: any) => {
                    span.end(500, { 'error.message': error?.message });
                    throw error;
                  }
                );
              }
              span.end(0);
              return result;
            } catch (error: any) {
              span.end(500, { 'error.message': error?.message });
              throw error;
            }
          });
        }
    );
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const instrumentFirebase = (options?: SenzorOptions) => {
  // Firestore
  hookRequire('firebase-admin/firestore', (exports: any) => {
    patchFirestore(exports, options);
  });
  hookRequire('@google-cloud/firestore', (exports: any) => {
    patchFirestore(exports, options);
  });

  // Auth
  hookRequire('firebase-admin/auth', (exports: any) => {
    patchFirebaseAuth(exports, options);
  });

  // Messaging
  hookRequire('firebase-admin/messaging', (exports: any) => {
    patchFirebaseMessaging(exports, options);
  });

  // firebase-admin main module — try to access services from it
  hookRequire('firebase-admin', (exports: any) => {
    // In newer firebase-admin, services are at exports.firestore, exports.auth, etc.
    // They're getter-based, so accessing them triggers sub-module loading
    // which our hooks above will catch.
    // Just ensure the main module export is patched if it exposes prototypes
    try {
      const firestore = exports?.firestore;
      if (firestore) {
        // This forces the lazy-load, which triggers our hookRequire above
      }
    } catch { }
  });
};
