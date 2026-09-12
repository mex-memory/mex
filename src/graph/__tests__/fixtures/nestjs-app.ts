import { Controller, Get, Post, Param, Delete, Version } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get()
  async findAll() {
    return [];
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return { id };
  }

  @Post(':id/posts')
  @HttpCode(201)
  createPost(@Param('id') id: string) {
    return { id, post: true };
  }

  @Version('1')
  @Get()
  listV1() {
    return ['v1'];
  }

  @Version('2')
  @Get()
  listV2() {
    return ['v2'];
  }
}

@Controller()
export class RootController {
  @Get('health')
  healthCheck() {
    return 'ok';
  }

  @All()
  fallback() {
    return 'fallback';
  }
}

// A commented-out route is not a route.
// @Get('legacy')
// legacyHandler() {}

@Controller({ path: 'admin', version: '2' })
export class AdminController {
  @Delete(':id')
  remove(@Param('id') id: string) {
    return { id };
  }
}

@Controller(ADMIN_PATH_CONSTANT)
export class UnreadableController {
  @Get('probe')
  probe() {
    return null;
  }
}
