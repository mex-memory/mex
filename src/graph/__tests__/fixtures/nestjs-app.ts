import { Controller, Get, Post, Param, Delete, Put, Patch, Options, Head, All } from '@nestjs/common';

@Controller('users')
export class UsersController {
  
  // Empty method path -> GET /users
  @Get()
  async findAll() {
    return [];
  }

  // Parameterized path -> GET /users/:id
  @Get(':id')
  findOne(@Param('id') id: string) {
    return { id };
  }

  // Nested parameterized path -> POST /users/:id/posts
  @Post(':id/posts')
  @HttpCode(201) // Simulate other decorators
  createPost(@Param('id') id: string) {
    return { id, post: true };
  }
  
  // Missing handler name (anonymous function) - Should not happen typically, but simulating edge case
  @Delete('anonymous')
  // We don't have a handler name here for extraction, let's just make it a normal one for positive testing
  deleteUser() {
    return false;
  }
}

// Controller with no prefix
@Controller()
export class RootController {
  @Get('health')
  healthCheck() {
    return 'ok';
  }
  
  @All() // Test All decorator
  fallback() {
    return 'fallback';
  }
}
