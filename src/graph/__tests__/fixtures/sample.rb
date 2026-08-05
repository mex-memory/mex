require "json"
require_relative "helpers"

module Greetings
  PREFIX = "Hello"

  class Base
    def speak
      warm_up
    end
  end

  class Greeter < Base
    include Comparable

    def initialize(name)
      @name = name
    end

    def self.default
      Greeter.new("World")
    end

    def greet
      format_name(@name)
    end
  end
end
