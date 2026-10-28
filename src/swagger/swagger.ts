import swaggerJsdoc from 'swagger-jsdoc';
import { config } from '../config';

const definition = {
  openapi: '3.0.3',
  info: {
    title: 'Language App API',
    version: '1.0.0',
    description: 'Authentication and content endpoints for admin and mobile clients.'
  },
  servers: [ { url: 'http://localhost:4000/api' } ],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      LessonItem: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          lessonId: { type: 'string' },
          order: { type: 'integer' },
          text: { type: 'string', description: 'Current content revision text' }
        }
      },
      Lesson: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string', nullable: true },
          status: {
            type: 'string',
            enum: [ 'DRAFT', 'PUBLISHED' ],
            description: 'Derived from currentPublicationId'
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          items: { type: 'array', items: { '$ref': '#/components/schemas/LessonItem' } },
          currentPublicationId: { type: 'string', nullable: true }
        }
      },
      LessonItemRequest: {
        type: 'object',
        required: [ 'text' ],
        additionalProperties: false,
        properties: { text: { type: 'string', minLength: 1, maxLength: 5000 } }
      },
      LessonRequest: {
        type: 'object',
        required: [ 'title', 'items' ],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 2 },
          description: { type: 'string' },
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: { '$ref': '#/components/schemas/LessonItemRequest' }
          }
        }
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'user_123' },
          email: { type: 'string', example: 'user@email.com' },
          name: { type: 'string', example: 'Mobile Learner' },
          role: { type: 'string', example: 'learner' }
        }
      },
      AuthResponse: {
        type: 'object',
        properties: {
          token: { type: 'string', example: 'jwt-token' },
          refreshToken: { type: 'string', example: 'refresh-token' },
          user: { '$ref': '#/components/schemas/User' }
        }
      },
      LoginRequest: {
        type: 'object',
        required: [ 'email', 'password' ],
        properties: {
          email: { type: 'string', format: 'email', example: 'user@email.com' },
          password: { type: 'string', minLength: 6, example: 'user#666' }
        }
      },
      SignupRequest: {
        type: 'object',
        required: [ 'name', 'email', 'password' ],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 80, example: 'Mobile Learner' },
          email: { type: 'string', format: 'email', example: 'user@email.com' },
          password: { type: 'string', minLength: 6, example: 'user#666' }
        }
      },
      RefreshRequest: {
        type: 'object',
        required: [ 'refreshToken' ],
        properties: { refreshToken: { type: 'string', minLength: 32, example: 'refresh-token' } }
      },
      LogoutRequest: {
        type: 'object',
        properties: { refreshToken: { type: 'string', minLength: 32, example: 'refresh-token' } }
      },
      MessageResponse: { type: 'object', properties: { message: { type: 'string', example: 'Logged out' } } },
      ErrorResponse: { type: 'object', properties: { message: { type: 'string', example: 'Invalid credentials' } } },
      AppVersionPolicy: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: [ 'android', 'ios' ] },
          enabled: { type: 'boolean' },
          latestBuildNumber: { type: 'integer', example: 24 },
          minSupportedBuildNumber: { type: 'integer', example: 20 },
          storeUrl: { type: 'string' },
          message: { type: 'string' }
        }
      },
      AppVersionResponse: {
        type: 'object',
        properties: {
          currentBuildNumber: { type: 'integer', example: 20 },
          policy: { '$ref': '#/components/schemas/AppVersionPolicy' },
          update: {
            type: 'object',
            properties: { available: { type: 'boolean' }, required: { type: 'boolean' } }
          }
        }
      },
      AnalyticsOverview: {
        type: 'object',
        properties: {
          totalLessons: { type: 'integer', example: 12 },
          publishedLessons: { type: 'integer', example: 8 },
          draftLessons: { type: 'integer', example: 4 },
          totalItems: { type: 'integer', example: 48 },
          avgItemsPerLesson: { type: 'number', example: 4 },
          latestPublishedLesson: {
            type: 'object',
            nullable: true,
            properties: {
              title: { type: 'string', example: 'Ordering Coffee' },
              publishedAt: { type: 'string', format: 'date-time' }
            }
          }
        }
      },
      LearnerProfile: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          email: { type: 'string' },
          name: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          vocabularySaved: { type: 'integer' },
          progressEvents: { type: 'integer' }
        }
      },
      LearnerLessonProgressSummary: {
        type: 'object',
        properties: {
          lessonId: { type: 'string' },
          lessonTitle: { type: 'string', nullable: true },
          lessonStatus: { type: 'string', nullable: true },
          totalEvents: { type: 'integer' },
          itemsStarted: { type: 'integer' },
          itemsCompleted: { type: 'integer' },
          bestCompletion: { type: 'integer', nullable: true },
          lastCompletion: { type: 'integer', nullable: true },
          lastActivityAt: { type: 'string', format: 'date-time' }
        }
      },
      LearnerProgressSummaryResponse: {
        type: 'object',
        properties: {
          learner: { '$ref': '#/components/schemas/LearnerProfile' },
          lessonSummaries: { type: 'array', items: { '$ref': '#/components/schemas/LearnerLessonProgressSummary' } }
        }
      },
      ProgressEventRequest: {
        type: 'object',
        required: [ 'idempotencyKey', 'lessonId', 'eventType' ],
        properties: {
          idempotencyKey: { type: 'string' },
          lessonId: { type: 'string' },
          lessonItemId: { type: 'string' },
          eventType: { type: 'string', enum: [ 'ITEM_STARTED', 'ITEM_COMPLETED', 'LESSON_COMPLETED' ] },
          completion: { type: 'integer' },
          clientTimestamp: { type: 'string', format: 'date-time' },
          payload: { type: 'object' }
        }
      },
      ProgressEventsRequest: {
        type: 'object',
        required: [ 'events' ],
        properties: { events: { type: 'array', items: { '$ref': '#/components/schemas/ProgressEventRequest' } } }
      },
      ProgressEventsResponse: {
        type: 'object',
        properties: { accepted: { type: 'integer' }, received: { type: 'integer' } }
      }
    }
  },
  tags: [
    { name: 'Auth', description: 'Authentication endpoints for admin and mobile clients.' },
    { name: 'Lessons', description: 'Lesson and task management.' },
    { name: 'Analytics', description: 'Admin analytics.' },
    { name: 'Learners', description: 'Admin learner management.' },
    { name: 'Progress', description: 'Learner progress ingestion endpoints.' },
    { name: 'Settings', description: 'Global app settings and mobile app update policy.' }
  ],
  paths: {
    '/app-version': {
      get: {
        tags: [ 'Settings' ],
        summary: 'Evaluate native app update policy for the current build',
        security: [ { bearerAuth: [] } ],
        parameters: [
          {
            name: 'platform',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: [ 'android', 'ios' ] }
          },
          {
            name: 'buildNumber',
            in: 'query',
            required: true,
            schema: { type: 'integer', minimum: 0 }
          }
        ],
        responses: {
          '200': {
            description: 'App version policy decision',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/AppVersionResponse' } } }
          }
        }
      }
    },
    '/auth/login': {
      post: {
        tags: [ 'Auth' ],
        summary: 'Authenticate user',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { '$ref': '#/components/schemas/LoginRequest' } } }
        },
        responses: {
          '200': {
            description: 'Authenticated successfully',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/AuthResponse' } } }
          },
          '400': {
            description: 'Invalid payload',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          },
          '401': {
            description: 'Invalid credentials',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/auth/signup': {
      post: {
        tags: [ 'Auth' ],
        summary: 'Create learner account',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { '$ref': '#/components/schemas/SignupRequest' } } }
        },
        responses: {
          '201': {
            description: 'Account created successfully',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/AuthResponse' } } }
          },
          '400': {
            description: 'Invalid payload',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          },
          '409': {
            description: 'Email already registered',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/auth/profile': {
      get: {
        tags: [ 'Auth' ],
        summary: 'Get current admin profile',
        security: [ { bearerAuth: [] } ],
        responses: {
          '200': {
            description: 'Current user profile',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { user: { '$ref': '#/components/schemas/User' } } }
              }
            }
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/auth/refresh': {
      post: {
        tags: [ 'Auth' ],
        summary: 'Refresh access token using refresh token rotation',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { '$ref': '#/components/schemas/RefreshRequest' } } }
        },
        responses: {
          '200': {
            description: 'Refreshed successfully',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/AuthResponse' } } }
          },
          '400': {
            description: 'Invalid payload',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          },
          '401': {
            description: 'Invalid or expired refresh token',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/auth/logout': {
      post: {
        tags: [ 'Auth' ],
        summary: 'Log out current admin session',
        security: [ { bearerAuth: [] } ],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { '$ref': '#/components/schemas/LogoutRequest' } } }
        },
        responses: {
          '200': {
            description: 'Logout acknowledged',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/MessageResponse' } } }
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/lessons': {
      get: {
        tags: [ 'Lessons' ],
        summary: 'List all lessons with ordered lesson items',
        security: [ { bearerAuth: [] } ],
        responses: {
          '200': {
            description: 'Lessons response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { lessons: { type: 'array', items: { '$ref': '#/components/schemas/Lesson' } } }
                }
              }
            }
          }
        }
      },
      post: {
        tags: [ 'Lessons' ],
        summary: 'Create a lesson',
        security: [ { bearerAuth: [] } ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { '$ref': '#/components/schemas/LessonRequest' } } }
        },
        responses: {
          '201': {
            description: 'Lesson created',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { lesson: { '$ref': '#/components/schemas/Lesson' } } }
              }
            }
          }
        }
      }
    },
    '/lessons/{id}': {
      delete: {
        tags: [ 'Lessons' ],
        summary: 'Delete a lesson (admin only)',
        description: 'Archives the lesson and its texts and revokes all publications. Shared vocabulary audio and learner history are retained. Queued or running audio must finish first.',
        security: [ { bearerAuth: [] } ],
        parameters: [ { name: 'id', in: 'path', required: true, schema: { type: 'string' } } ],
        responses: {
          '204': { description: 'Lesson deleted' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Admin access required' },
          '404': { description: 'Lesson missing or already deleted' },
          '409': { description: 'Audio is still queued or generating' },
        },
      },
      get: {
        tags: [ 'Lessons' ],
        summary: 'Get lesson by ID',
        security: [ { bearerAuth: [] } ],
        parameters: [ { name: 'id', in: 'path', required: true, schema: { type: 'string' } } ],
        responses: {
          '200': {
            description: 'Lesson detail',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { lesson: { '$ref': '#/components/schemas/Lesson' } } }
              }
            }
          },
          '404': {
            description: 'Lesson not found',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          }
        }
      },
      patch: {
        tags: [ 'Lessons' ],
        summary: 'Update lesson',
        security: [ { bearerAuth: [] } ],
        parameters: [ { name: 'id', in: 'path', required: true, schema: { type: 'string' } } ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  items: {
                    type: 'array',
                    items: { type: 'object', required: [ 'id' ], properties: { id: { type: 'string' } } },
                    description: 'Ordered active text IDs; omitted texts are archived, never deleted'
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Lesson updated',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { lesson: { '$ref': '#/components/schemas/Lesson' } } }
              }
            }
          }
        }
      }
    },
    '/lessons/{lessonId}/items': {
      post: {
        tags: [ 'Lessons' ],
        summary: 'Create lesson item within lesson',
        security: [ { bearerAuth: [] } ],
        parameters: [ { name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } } ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { '$ref': '#/components/schemas/LessonItemRequest' } } }
        },
        responses: {
          '201': {
            description: 'Task created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { item: { '$ref': '#/components/schemas/LessonItem' } }
                }
              }
            }
          },
          '404': {
            description: 'Lesson not found',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/analytics/overview': {
      get: {
        tags: [ 'Analytics' ],
        summary: 'Get lesson/item summary metrics',
        security: [ { bearerAuth: [] } ],
        responses: {
          '200': {
            description: 'Overview stats',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { stats: { '$ref': '#/components/schemas/AnalyticsOverview' } }
                }
              }
            }
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/learners': {
      get: {
        tags: [ 'Learners' ],
        summary: 'List learner accounts for admin dashboard',
        security: [ { bearerAuth: [] } ],
        responses: {
          '200': {
            description: 'Learner list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    learners: { type: 'array', items: { '$ref': '#/components/schemas/LearnerProfile' } }
                  }
                }
              }
            }
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/learners/{learnerId}/progress-summary': {
      get: {
        tags: [ 'Learners' ],
        summary: 'Get learner progress summary grouped by lesson',
        security: [ { bearerAuth: [] } ],
        parameters: [ { name: 'learnerId', in: 'path', required: true, schema: { type: 'string' } } ],
        responses: {
          '200': {
            description: 'Learner progress summary',
            content: {
              'application/json': { schema: { '$ref': '#/components/schemas/LearnerProgressSummaryResponse' } }
            }
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          },
          '404': {
            description: 'Learner not found',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/me/progress/events': {
      post: {
        tags: [ 'Progress' ],
        summary: 'Ingest batched learner progress events',
        security: [ { bearerAuth: [] } ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { '$ref': '#/components/schemas/ProgressEventsRequest' } }
          }
        },
        responses: {
          '202': {
            description: 'Batch accepted',
            content: {
              'application/json': { schema: { '$ref': '#/components/schemas/ProgressEventsResponse' } }
            }
          },
          '400': {
            description: 'Invalid payload',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { '$ref': '#/components/schemas/ErrorResponse' } } }
          }
        }
      }
    },
    '/admin/vocabulary': {
      get: {
        tags: ['Vocabulary library'], summary: 'Search saved words, phrases and Armenian meanings', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string', maxLength: 200 } }, { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } }],
        responses: { '200': { description: 'Paginated terms with translations and saved recording counts' }, '401': { description: 'Authentication required' }, '403': { description: 'Admin access required' } },
      },
    },
    '/admin/vocabulary/{termId}': {
      get: {
        tags: ['Vocabulary library'], summary: 'Saved recordings, preferred choices and source lessons', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'termId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Term, meanings, recordings, availability and current/historical usages' }, '403': { description: 'Admin access required' }, '404': { description: 'Vocabulary entry not found' } },
      },
    },
    '/admin/vocabulary/meanings/{meaningId}/preference': {
      put: {
        tags: ['Vocabulary library'], summary: 'Choose or clear a saved recording for standalone vocabulary practice', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'meaningId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false,
          required: ['voiceId', 'recordingId', 'expectedRecordingId'], properties: { voiceId: { type: 'string' }, recordingId: { type: 'string', nullable: true }, expectedRecordingId: { type: 'string', nullable: true } },
        } } } },
        responses: { '200': { description: 'Preference saved; existing file reused without changing lesson manifests' }, '403': { description: 'Admin access required' }, '409': { description: 'Concurrent preference change; reload before retrying' }, '422': { description: 'Unavailable recording or mismatched meaning/voice' } },
      },
    },
    '/admin/lessons/{lessonId}/publish': {
      post: {
        tags: [ 'Text authoring' ],
        summary: 'Atomically publish all current texts after vocabulary audio is prepared',
        security: [ { bearerAuth: [] } ],
        parameters: [ { name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } } ],
        responses: {
          '200': { description: 'Idempotent replay of current publication' },
          '201': {
            description: 'Published and immediately visible through GET /learner/lessons',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    publicationId: { type: 'string' },
                    replay: { type: 'boolean' },
                    status: { type: 'string', enum: [ 'PUBLISHED' ] }
                  }
                }
              }
            }
          },
          '422': {
            description: 'No partial publication: { code: LESSON_NOT_READY, message, texts: [{ textId, order, readiness, message? }] }'
          }
        },
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { type: 'object', additionalProperties: false } } }
        }
      }
    },
    '/admin/lessons/{lessonId}/texts/{textId}/vocabulary/audio-plan': {
      get: {
        tags: ['Text authoring'], summary: 'Preview reusable recordings and missing standalone word audio', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'textId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Draft version, voice, entries, reuseCount and distinct generateCount' }, '403': { description: 'Admin access required' }, '422': { description: 'Save narration, selections and Armenian translations first' } },
      },
    },
    '/admin/lessons/{lessonId}/texts/{textId}/vocabulary/audio-jobs': {
      post: {
        tags: ['Text authoring'], summary: 'Reuse saved vocabulary audio and generate only missing words', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'textId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', maxLength: 200 } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['expectedDraftVersion'], properties: { expectedDraftVersion: { type: 'integer', minimum: 0 } } } } } },
        responses: { '202': { description: 'Durable job queued or replayed; poll the existing audio-job endpoint' }, '409': { description: 'Stale draft, conflicting key or another active job' }, '503': { description: 'Missing audio needs provider configuration' } },
      },
    },
    '/learner/publications/{publicationId}/activate-vocabulary': {
      post: {
        tags: ['Reader'], summary: 'Mark unmarked learning words across a lesson as unknown', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'publicationId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['clientUpdatedAt'], properties: { clientUpdatedAt: { type: 'string', format: 'date-time' } } } } } },
        responses: { '200': { description: 'Updated per-learner word states and activatedCount; learned states and newer choices are preserved' }, '400': { description: 'Invalid timestamp' }, '404': { description: 'Publication unavailable or withdrawn' } },
      },
    },
    '/admin/lessons/{lessonId}/unpublish': {
      post: {
        tags: [ 'Text authoring' ],
        summary: 'Withdraw the lesson and its prior publications',
        security: [ { bearerAuth: [] } ],
        parameters: [ { name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } } ],
        responses: {
          '200': { description: 'Success' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Admin access required' }
        }
      }
    },
    '/admin/lessons/{lessonId}/texts/{textId}': {
      get: {
        tags: [ 'Text authoring' ],
        summary: 'Load saved text, narration, alignment and active narration job',
        security: [ { bearerAuth: [] } ],
        parameters: [
          { name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'textId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Success' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Admin access required' }
        }
      }
    },
    '/admin/lessons/{lessonId}/texts/{textId}/content-revisions': {
      post: {
        tags: [ 'Text authoring' ],
        summary: 'Save authoritative text; invalidate narration, alignment and selections',
        security: [ { bearerAuth: [] } ],
        parameters: [
          { name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'textId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Success' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Admin access required' }
        }
      }
    },
    '/admin/lessons/{lessonId}/texts/{textId}/narration-jobs': {
      post: {
        tags: [ 'Text authoring' ],
        summary: 'Explicitly request ElevenLabs narration; Idempotency-Key required',
        security: [ { bearerAuth: [] } ],
        parameters: [
          { name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'textId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Success' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Admin access required' }
        }
      }
    },
    '/admin/lessons/{lessonId}/texts/{textId}/occurrences': {
      get: {
        tags: [ 'Text authoring' ],
        summary: 'Current aligned word occurrences and contextual translations',
        security: [ { bearerAuth: [] } ],
        parameters: [
          { name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'textId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Success' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Admin access required' }
        }
      }
    },
    '/admin/lessons/{lessonId}/texts/{textId}/selection': {
      patch: {
        tags: [ 'Text authoring' ],
        summary: 'Select learning occurrences',
        security: [ { bearerAuth: [] } ],
        parameters: [
          { name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'textId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Success' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Admin access required' }
        }
      }
    },
    '/admin/lessons/{lessonId}/texts/{textId}/readiness': {
      get: {
        tags: [ 'Text authoring' ],
        summary: 'Check publication readiness; selected words require saved audio',
        security: [ { bearerAuth: [] } ],
        parameters: [
          { name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'textId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Success' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Admin access required' }
        }
      }
    },
    '/admin/lessons/{lessonId}/texts/{textId}/vocabulary/{entryId}': {
      patch: {
        tags: [ 'Text authoring' ],
        summary: 'Save contextual translations; Armenian language code is hy',
        security: [ { bearerAuth: [] } ],
        parameters: [
          { name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'textId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'entryId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'Success' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Admin access required' }
        }
      }
    },
    '/learner/lessons': {
      get: {
        tags: [ 'Text authoring' ],
        summary: 'List current published lessons',
        security: [ { bearerAuth: [] } ],
        parameters: [],
        responses: {
          '200': { description: 'Success' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Admin access required' }
        }
      }
    },
    '/learner/lessons/{lessonId}/manifest': {
      get: {
        tags: [ 'Text authoring' ],
        summary: 'Load immutable reader manifest, word state and progress',
        security: [ { bearerAuth: [] } ],
        parameters: [ { name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } } ],
        responses: {
          '200': { description: 'Success' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Admin access required' }
        }
      }
    },
    '/learner/audio-assets/{assetId}/content': {
      get: {
        tags: [ 'Text authoring' ],
        summary: 'Authenticated audio from publicationId query parameter; supports byte ranges',
        security: [ { bearerAuth: [] } ],
        parameters: [ { name: 'assetId', in: 'path', required: true, schema: { type: 'string' } } ],
        responses: {
          '200': { description: 'Success' },
          '401': { description: 'Authentication required' },
          '403': { description: 'Admin access required' }
        }
      }
    }
  }
};
definition.servers = [{ url: `http://localhost:${config.port}/api` }];
export const swaggerSpec = swaggerJsdoc({ definition, apis: [] });
