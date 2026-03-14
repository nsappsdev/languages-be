import swaggerJsdoc from 'swagger-jsdoc';
import { config } from '../config';

const swaggerDefinition = {
  openapi: '3.0.3',
  info: {
    title: 'Language App API',
    version: '1.0.0',
    description: 'Authentication and content endpoints for admin and mobile clients.',
  },
  servers: [
    {
      url: `http://localhost:${config.port}/api`,
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      Lesson: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['DRAFT', 'PUBLISHED'] },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Task: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          prompt: { type: 'string' },
          type: { type: 'string', enum: ['PICK_ONE', 'FILL_IN_BLANK', 'MATCH'] },
          order: { type: 'integer' },
          config: { type: 'object' },
          options: {
            type: 'array',
            items: { $ref: '#/components/schemas/TaskOption' },
          },
        },
      },
      TaskOption: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          isCorrect: { type: 'boolean' },
        },
      },
      LessonRequest: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['DRAFT', 'PUBLISHED'] },
          tasks: {
            type: 'array',
            items: { $ref: '#/components/schemas/TaskRequest' },
          },
        },
        required: ['title'],
      },
      TaskRequest: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          type: { type: 'string', enum: ['PICK_ONE', 'FILL_IN_BLANK', 'MATCH'] },
          order: { type: 'integer' },
          config: { type: 'object' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                isCorrect: { type: 'boolean' },
              },
            },
          },
        },
        required: ['prompt', 'type'],
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'user_123' },
          email: { type: 'string', example: 'user@email.com' },
          name: { type: 'string', example: 'Mobile Learner' },
          role: { type: 'string', example: 'learner' },
        },
      },
      AuthResponse: {
        type: 'object',
        properties: {
          token: { type: 'string', example: 'jwt-token' },
          refreshToken: { type: 'string', example: 'refresh-token' },
          user: { $ref: '#/components/schemas/User' },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: {
            type: 'string',
            format: 'email',
            example: 'user@email.com',
          },
          password: {
            type: 'string',
            minLength: 6,
            example: 'user#666',
          },
        },
      },
      SignupRequest: {
        type: 'object',
        required: ['name', 'email', 'password'],
        properties: {
          name: {
            type: 'string',
            minLength: 2,
            maxLength: 80,
            example: 'Mobile Learner',
          },
          email: {
            type: 'string',
            format: 'email',
            example: 'user@email.com',
          },
          password: {
            type: 'string',
            minLength: 6,
            example: 'user#666',
          },
        },
      },
      RefreshRequest: {
        type: 'object',
        required: ['refreshToken'],
        properties: {
          refreshToken: {
            type: 'string',
            minLength: 32,
            example: 'refresh-token',
          },
        },
      },
      LogoutRequest: {
        type: 'object',
        properties: {
          refreshToken: {
            type: 'string',
            minLength: 32,
            example: 'refresh-token',
          },
        },
      },
      MessageResponse: {
        type: 'object',
        properties: {
          message: { type: 'string', example: 'Logged out' },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          message: { type: 'string', example: 'Invalid credentials' },
        },
      },
      AnalyticsOverview: {
        type: 'object',
        properties: {
          totalLessons: { type: 'integer', example: 12 },
          publishedLessons: { type: 'integer', example: 8 },
          draftLessons: { type: 'integer', example: 4 },
          totalTasks: { type: 'integer', example: 48 },
          avgTasksPerLesson: { type: 'number', example: 4 },
          latestPublishedLesson: {
            type: 'object',
            nullable: true,
            properties: {
              title: { type: 'string', example: 'Ordering Coffee' },
              publishedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
      VocabularyEntry: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          englishText: { type: 'string' },
          kind: { type: 'string', enum: ['WORD', 'PHRASE', 'SENTENCE'] },
          notes: { type: 'string', nullable: true },
          tags: { type: 'array', items: { type: 'string' } },
          translations: {
            type: 'array',
            items: { $ref: '#/components/schemas/VocabularyTranslation' },
          },
        },
      },
      VocabularyEntryRequest: {
        type: 'object',
        properties: {
          englishText: { type: 'string' },
          kind: { type: 'string', enum: ['WORD', 'PHRASE', 'SENTENCE'] },
          notes: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          translations: {
            type: 'array',
            items: { $ref: '#/components/schemas/VocabularyTranslationRequest' },
          },
        },
        required: ['englishText'],
      },
      VocabularyTranslation: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          languageCode: { type: 'string' },
          translation: { type: 'string' },
          usageExample: { type: 'string', nullable: true },
        },
      },
      VocabularyTranslationRequest: {
        type: 'object',
        properties: {
          languageCode: { type: 'string' },
          translation: { type: 'string' },
          usageExample: { type: 'string' },
        },
        required: ['languageCode', 'translation'],
      },
      LearnerVocabulary: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['NEW', 'REVIEWING', 'MASTERED'] },
          entry: { $ref: '#/components/schemas/VocabularyEntry' },
        },
      },
      LearnerVocabularyStatusRequest: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['NEW', 'REVIEWING', 'MASTERED'] },
        },
        required: ['status'],
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
          progressEvents: { type: 'integer' },
        },
      },
      LearnerLessonProgressSummary: {
        type: 'object',
        properties: {
          lessonId: { type: 'string' },
          lessonTitle: { type: 'string', nullable: true },
          lessonStatus: { type: 'string', nullable: true },
          totalEvents: { type: 'integer' },
          attemptEvents: { type: 'integer' },
          correctAttempts: { type: 'integer' },
          tasksCompleted: { type: 'integer' },
          bestScore: { type: 'integer', nullable: true },
          lastScore: { type: 'integer', nullable: true },
          bestCompletion: { type: 'integer', nullable: true },
          lastActivityAt: { type: 'string', format: 'date-time' },
        },
      },
      LearnerProgressSummaryResponse: {
        type: 'object',
        properties: {
          learner: { $ref: '#/components/schemas/LearnerProfile' },
          lessonSummaries: {
            type: 'array',
            items: { $ref: '#/components/schemas/LearnerLessonProgressSummary' },
          },
        },
      },
      ProgressEventRequest: {
        type: 'object',
        required: ['idempotencyKey', 'lessonId', 'eventType'],
        properties: {
          idempotencyKey: { type: 'string' },
          lessonId: { type: 'string' },
          taskId: { type: 'string' },
          eventType: { type: 'string', enum: ['TASK_ATTEMPT', 'TASK_COMPLETED', 'LESSON_COMPLETED'] },
          attemptNumber: { type: 'integer' },
          isCorrect: { type: 'boolean' },
          score: { type: 'integer' },
          completion: { type: 'integer' },
          clientTimestamp: { type: 'string', format: 'date-time' },
          payload: { type: 'object' },
        },
      },
      ProgressEventsRequest: {
        type: 'object',
        required: ['events'],
        properties: {
          events: {
            type: 'array',
            items: { $ref: '#/components/schemas/ProgressEventRequest' },
          },
        },
      },
      ProgressEventsResponse: {
        type: 'object',
        properties: {
          accepted: { type: 'integer' },
          received: { type: 'integer' },
        },
      },
    },
  },
  tags: [
    {
      name: 'Auth',
      description: 'Authentication endpoints for admin and mobile clients.',
    },
    {
      name: 'Lessons',
      description: 'Lesson and task management.',
    },
    {
      name: 'Analytics',
      description: 'Admin analytics.',
    },
    {
      name: 'Vocabulary',
      description: 'Vocabulary library management.',
    },
    {
      name: 'Learners',
      description: 'Admin learner management.',
    },
    {
      name: 'Progress',
      description: 'Learner progress ingestion endpoints.',
    },
  ],
  paths: {
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Authenticate user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LoginRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Authenticated successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AuthResponse' },
              },
            },
          },
          400: {
            description: 'Invalid payload',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          401: {
            description: 'Invalid credentials',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/auth/signup': {
      post: {
        tags: ['Auth'],
        summary: 'Create learner account',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SignupRequest' },
            },
          },
        },
        responses: {
          201: {
            description: 'Account created successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AuthResponse' },
              },
            },
          },
          400: {
            description: 'Invalid payload',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          409: {
            description: 'Email already registered',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/auth/profile': {
      get: {
        tags: ['Auth'],
        summary: 'Get current admin profile',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Current user profile',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    user: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
          401: {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Refresh access token using refresh token rotation',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RefreshRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Refreshed successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AuthResponse' },
              },
            },
          },
          400: {
            description: 'Invalid payload',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          401: {
            description: 'Invalid or expired refresh token',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Log out current admin session',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LogoutRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Logout acknowledged',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MessageResponse' },
              },
            },
          },
          401: {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/lessons': {
      get: {
        tags: ['Lessons'],
        summary: 'List all lessons with tasks',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Lessons response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    lessons: {
                      type: 'array',
                      items: {
                        allOf: [
                          { $ref: '#/components/schemas/Lesson' },
                          {
                            type: 'object',
                            properties: {
                              tasks: {
                                type: 'array',
                                items: { $ref: '#/components/schemas/Task' },
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Lessons'],
        summary: 'Create a lesson',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LessonRequest' } } },
        },
        responses: {
          201: {
            description: 'Lesson created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    lesson: {
                      allOf: [
                        { $ref: '#/components/schemas/Lesson' },
                        {
                          type: 'object',
                          properties: {
                            tasks: {
                              type: 'array',
                              items: { $ref: '#/components/schemas/Task' },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/lessons/{id}': {
      get: {
        tags: ['Lessons'],
        summary: 'Get lesson by ID',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Lesson detail',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    lesson: {
                      allOf: [
                        { $ref: '#/components/schemas/Lesson' },
                        {
                          properties: {
                            tasks: {
                              type: 'array',
                              items: { $ref: '#/components/schemas/Task' },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          404: {
            description: 'Lesson not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
      patch: {
        tags: ['Lessons'],
        summary: 'Update lesson',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LessonRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Lesson updated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    lesson: {
                      allOf: [
                        { $ref: '#/components/schemas/Lesson' },
                        {
                          properties: {
                            tasks: {
                              type: 'array',
                              items: { $ref: '#/components/schemas/Task' },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
      delete: {
        tags: ['Lessons'],
        summary: 'Delete lesson',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          204: { description: 'Deleted' },
          404: {
            description: 'Lesson not found',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
        },
      },
    },
    '/lessons/{lessonId}/tasks': {
      post: {
        tags: ['Lessons'],
        summary: 'Create task within lesson',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TaskRequest' },
            },
          },
        },
        responses: {
          201: {
            description: 'Task created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { task: { $ref: '#/components/schemas/Task' } },
                },
              },
            },
          },
          404: {
            description: 'Lesson not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
        },
      },
    },
    '/lessons/{lessonId}/tasks/{taskId}': {
      delete: {
        tags: ['Lessons'],
        summary: 'Delete task from lesson',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'lessonId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'taskId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          204: { description: 'Deleted' },
          404: {
            description: 'Task not found',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
        },
      },
    },
    '/analytics/overview': {
      get: {
        tags: ['Analytics'],
        summary: 'Get lesson/task summary metrics',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Overview stats',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    stats: { $ref: '#/components/schemas/AnalyticsOverview' },
                  },
                },
              },
            },
          },
          401: {
            description: 'Unauthorized',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
        },
      },
    },
    '/learners': {
      get: {
        tags: ['Learners'],
        summary: 'List learner accounts for admin dashboard',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Learner list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    learners: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/LearnerProfile' },
                    },
                  },
                },
              },
            },
          },
          403: {
            description: 'Forbidden',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
        },
      },
    },
    '/learners/{learnerId}/progress-summary': {
      get: {
        tags: ['Learners'],
        summary: 'Get learner progress summary grouped by lesson',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'learnerId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: 'Learner progress summary',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LearnerProgressSummaryResponse' },
              },
            },
          },
          403: {
            description: 'Forbidden',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
          404: {
            description: 'Learner not found',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
        },
      },
    },
    '/vocabulary': {
      get: {
        tags: ['Vocabulary'],
        summary: 'List vocabulary entries',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Entries list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    entries: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/VocabularyEntry' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Vocabulary'],
        summary: 'Create vocabulary entry',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/VocabularyEntryRequest' },
            },
          },
        },
        responses: {
          201: {
            description: 'Entry created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { entry: { $ref: '#/components/schemas/VocabularyEntry' } },
                },
              },
            },
          },
        },
      },
    },
    '/vocabulary/{id}': {
      get: {
        tags: ['Vocabulary'],
        summary: 'Get entry by id',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Entry detail',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { entry: { $ref: '#/components/schemas/VocabularyEntry' } },
                },
              },
            },
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
        },
      },
      patch: {
        tags: ['Vocabulary'],
        summary: 'Update entry',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/VocabularyEntryRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Updated entry',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { entry: { $ref: '#/components/schemas/VocabularyEntry' } },
                },
              },
            },
          },
        },
      },
      delete: {
        tags: ['Vocabulary'],
        summary: 'Delete entry',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          204: { description: 'Deleted' },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
        },
      },
    },
    '/vocabulary/{entryId}/translations': {
      post: {
        tags: ['Vocabulary'],
        summary: 'Add translation to entry',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'entryId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/VocabularyTranslationRequest' },
            },
          },
        },
        responses: {
          201: {
            description: 'Translation created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { translation: { $ref: '#/components/schemas/VocabularyTranslation' } },
                },
              },
            },
          },
        },
      },
    },
    '/vocabulary/{entryId}/translations/{translationId}': {
      patch: {
        tags: ['Vocabulary'],
        summary: 'Update translation',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'entryId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'translationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/VocabularyTranslationRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Updated translation',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { translation: { $ref: '#/components/schemas/VocabularyTranslation' } },
                },
              },
            },
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
        },
      },
      delete: {
        tags: ['Vocabulary'],
        summary: 'Delete translation',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'entryId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'translationId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          204: { description: 'Deleted' },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
        },
      },
    },
    '/me/vocabulary': {
      get: {
        tags: ['Vocabulary'],
        summary: 'List learner saved vocabulary',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Learner vocabulary list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    vocabulary: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/LearnerVocabulary' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/me/vocabulary/{entryId}': {
      post: {
        tags: ['Vocabulary'],
        summary: 'Save entry to learner library',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'entryId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          201: {
            description: 'Saved entry',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { vocabulary: { $ref: '#/components/schemas/LearnerVocabulary' } },
                },
              },
            },
          },
          404: {
            description: 'Entry not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
        },
      },
      patch: {
        tags: ['Vocabulary'],
        summary: 'Update learner word status',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'entryId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LearnerVocabularyStatusRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Updated entry',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { vocabulary: { $ref: '#/components/schemas/LearnerVocabulary' } },
                },
              },
            },
          },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
        },
      },
      delete: {
        tags: ['Vocabulary'],
        summary: 'Remove entry from learner library',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'entryId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          204: { description: 'Removed' },
          404: {
            description: 'Not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
        },
      },
    },
    '/me/progress/events': {
      post: {
        tags: ['Progress'],
        summary: 'Ingest batched learner progress events',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProgressEventsRequest' },
            },
          },
        },
        responses: {
          202: {
            description: 'Batch accepted',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ProgressEventsResponse' },
              },
            },
          },
          400: {
            description: 'Invalid payload',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
          403: {
            description: 'Forbidden',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
        },
      },
    },
  },
};

export const swaggerSpec = swaggerJsdoc({
  definition: swaggerDefinition,
  apis: [],
});
