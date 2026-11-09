<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** The four tables PdoStore uses, with the default agent_email_guard prefix. */
return new class () extends Migration {
    public function up(): void
    {
        Schema::create('agent_email_guard_counters', static function (Blueprint $table): void {
            $table->string('name', 512)->primary();
            $table->bigInteger('value');
            $table->bigInteger('expires_at')->nullable();
        });
        Schema::create('agent_email_guard_windows', static function (Blueprint $table): void {
            $table->string('name', 512);
            $table->string('member', 128);
            $table->bigInteger('at');
            $table->primary(['name', 'member']);
        });
        Schema::create('agent_email_guard_sends', static function (Blueprint $table): void {
            $table->bigIncrements('id');
            $table->string('log', 512);
            $table->bigInteger('at');
            $table->mediumText('record');
            $table->index(['log', 'at']);
        });
        Schema::create('agent_email_guard_state', static function (Blueprint $table): void {
            $table->string('name', 512)->primary();
            $table->mediumText('value');
        });
    }

    public function down(): void
    {
        foreach (['agent_email_guard_state', 'agent_email_guard_sends', 'agent_email_guard_windows', 'agent_email_guard_counters'] as $table) {
            Schema::dropIfExists($table);
        }
    }
};
